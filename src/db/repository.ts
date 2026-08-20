import type pg from "pg";
import type {
  ProxyCandidate,
  ProxyProtocol,
  ProxyRecord,
  ProxyStatus,
  SourceRecord,
  ValidationResult,
} from "../types.js";

const PROXY_COLUMNS = `
  id, host, port, protocol, source,
  first_seen, last_seen, last_checked, last_success,
  success_count, failure_count, consecutive_failures,
  latency_ms, success_rate, exit_ip, country, supports_https,
  score, status, quarantined_until, last_error, probe
`;

function rowToProxy(row: Record<string, unknown>): ProxyRecord {
  return {
    id: Number(row.id),
    host: row.host as string,
    port: Number(row.port),
    protocol: row.protocol as ProxyProtocol,
    source: row.source as string,
    first_seen: row.first_seen as Date,
    last_seen: row.last_seen as Date,
    last_checked: (row.last_checked as Date | null) ?? null,
    last_success: (row.last_success as Date | null) ?? null,
    success_count: Number(row.success_count),
    failure_count: Number(row.failure_count),
    consecutive_failures: Number(row.consecutive_failures),
    latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
    success_rate: Number(row.success_rate),
    exit_ip: (row.exit_ip as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    supports_https: Boolean(row.supports_https),
    score: Number(row.score),
    status: row.status as ProxyStatus,
    quarantined_until: (row.quarantined_until as Date | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    probe: Boolean(row.probe),
  };
}

export class Repository {
  constructor(private readonly db: pg.Pool) {}

  // ---- proxies ----

  async upsertCandidate(candidate: ProxyCandidate): Promise<ProxyRecord> {
    const protocol = candidate.protocol === "auto" ? "http" : candidate.protocol;
    const probe = candidate.protocol === "auto";
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO proxies (host, port, protocol, source, status, probe)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (host, port, protocol)
       DO UPDATE SET
         source = EXCLUDED.source,
         last_seen = now(),
         probe = proxies.probe OR EXCLUDED.probe,
         status = CASE
           WHEN proxies.status = 'dead' THEN 'pending'
           ELSE proxies.status
         END
       RETURNING ${PROXY_COLUMNS}`,
      [candidate.host, candidate.port, protocol, candidate.source, probe]
    );
    return rowToProxy(rows[0]!);
  }

  async applyValidationResult(
    proxyId: number,
    result: ValidationResult
  ): Promise<ProxyRecord | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE proxies SET
         last_checked = now(),
         supports_https = $2,
         exit_ip = COALESCE($3, exit_ip),
         latency_ms = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING ${PROXY_COLUMNS}`,
      [proxyId, result.supportsHttps, result.exitIp, result.ok ? result.latencyMs : null]
    );
    const row = rows[0];
    if (!row) return null;
    const proxy = rowToProxy(row);
    if (result.ok) {
      return this.recordSuccess(proxy, result);
    }
    return this.recordFailure(proxy, result.error);
  }

  async recordSuccess(
    proxy: ProxyRecord,
    result?: Pick<ValidationResult, "exitIp" | "latencyMs" | "supportsHttps">
  ): Promise<ProxyRecord> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE proxies SET
         success_count = success_count + 1,
         consecutive_failures = 0,
         last_success = now(),
         last_checked = now(),
         latency_ms = $2,
         exit_ip = COALESCE($3, exit_ip),
         supports_https = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING ${PROXY_COLUMNS}`,
      [
        proxy.id,
        result?.latencyMs ?? proxy.latency_ms,
        result?.exitIp ?? proxy.exit_ip,
        result?.supportsHttps ?? proxy.supports_https,
      ]
    );
    return rowToProxy(rows[0]!);
  }

  async recordFailure(
    proxy: ProxyRecord,
    error?: string | null
  ): Promise<ProxyRecord> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE proxies SET
         failure_count = failure_count + 1,
         consecutive_failures = consecutive_failures + 1,
         last_checked = now(),
         last_error = $2,
         updated_at = now()
       WHERE id = $1
       RETURNING ${PROXY_COLUMNS}`,
      [proxy.id, error ? String(error).slice(0, 300) : null]
    );
    return rowToProxy(rows[0]!);
  }

  async setStatus(
    proxyId: number,
    status: ProxyStatus,
    extras?: { quarantinedUntil?: Date | null; lastError?: string | null }
  ): Promise<ProxyRecord | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE proxies SET
         status = $2,
         quarantined_until = $3,
         last_error = COALESCE($4, last_error),
         updated_at = now()
       WHERE id = $1
       RETURNING ${PROXY_COLUMNS}`,
      [
        proxyId,
        status,
        extras?.quarantinedUntil ?? null,
        extras?.lastError ?? null,
      ]
    );
    return rows[0] ? rowToProxy(rows[0]) : null;
  }

  async updateScore(proxyId: number, score: number): Promise<void> {
    await this.db.query(
      `UPDATE proxies SET score = $2, updated_at = now() WHERE id = $1`,
      [proxyId, score]
    );
  }

  async clearProbe(proxyId: number): Promise<void> {
    await this.db.query(
      `UPDATE proxies SET probe = false, updated_at = now() WHERE id = $1`,
      [proxyId]
    );
  }

  async getProxy(id: number): Promise<ProxyRecord | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToProxy(rows[0]) : null;
  }

  async getByKey(
    host: string,
    port: number,
    protocol: ProxyProtocol
  ): Promise<ProxyRecord | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies WHERE host = $1 AND port = $2 AND protocol = $3`,
      [host, port, protocol]
    );
    return rows[0] ? rowToProxy(rows[0]) : null;
  }

  async listProxies(opts: {
    limit?: number;
    offset?: number;
    status?: ProxyStatus | "all";
    protocol?: ProxyProtocol | "all";
    minScore?: number;
  }): Promise<ProxyRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.status && opts.status !== "all") {
      params.push(opts.status);
      clauses.push(`status = $${params.length}`);
    }
    if (opts.protocol && opts.protocol !== "all") {
      params.push(opts.protocol);
      clauses.push(`protocol = $${params.length}`);
    }
    if (opts.minScore != null) {
      params.push(opts.minScore);
      clauses.push(`score >= $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies
       ${where}
       ORDER BY score DESC, latency_ms ASC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows.map(rowToProxy);
  }

  async getHealthyProxies(): Promise<ProxyRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies
       WHERE status = 'healthy'
       ORDER BY score DESC, latency_ms ASC NULLS LAST`
    );
    return rows.map(rowToProxy);
  }

  async getProxiesByStatus(statuses: ProxyStatus[]): Promise<ProxyRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies WHERE status = ANY($1::text[])`,
      [statuses]
    );
    return rows.map(rowToProxy);
  }

  async getPending(): Promise<ProxyRecord[]> {
    return this.getProxiesByStatus(["pending", "discovered"]);
  }

  async getQuarantinedDue(): Promise<ProxyRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROXY_COLUMNS} FROM proxies
       WHERE status = 'quarantined'
         AND (quarantined_until IS NULL OR quarantined_until <= now())`
    );
    return rows.map(rowToProxy);
  }

  async countByStatus(): Promise<Record<ProxyStatus, number>> {
    const { rows } = await this.db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM proxies GROUP BY status`
    );
    const out: Record<string, number> = {
      discovered: 0,
      pending: 0,
      healthy: 0,
      degraded: 0,
      quarantined: 0,
      dead: 0,
    };
    for (const r of rows) out[r.status] = Number(r.count);
    return out as Record<ProxyStatus, number>;
  }

  async countByProtocol(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ protocol: string; count: string }>(
      `SELECT protocol, COUNT(*)::text AS count FROM proxies GROUP BY protocol`
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.protocol] = Number(r.count);
    return out;
  }

  async totalCount(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM proxies`
    );
    return Number(rows[0]?.count ?? 0);
  }

  async stats(): Promise<{
    medianLatencyMs: number | null;
    validationSuccessRate: number;
    totalChecks: number;
  }> {
    const { rows } = await this.db.query<{
      median: string | null;
      total: string;
      successes: string;
    }>(
      `SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::text AS median,
         (SELECT COUNT(*)::text FROM proxies) AS total,
         (SELECT COUNT(*)::text FROM proxies WHERE success_count > 0) AS successes`
    );
    const total = Number(rows[0]?.total ?? 0);
    const successes = Number(rows[0]?.successes ?? 0);
    return {
      medianLatencyMs: rows[0]?.median ? Number(rows[0].median) : null,
      validationSuccessRate: total > 0 ? successes / total : 0,
      totalChecks: total,
    };
  }

  async markDead(olderThanMs: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE proxies SET status = 'dead', updated_at = now()
       WHERE status IN ('discovered', 'pending')
         AND last_seen < now() - ($1::bigint * interval '1 millisecond')`,
      [olderThanMs]
    );
    return rowCount ?? 0;
  }

  // ---- sources ----

  async ensureSource(
    name: string,
    url: string,
    kind: string
  ): Promise<SourceRecord> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO sources (name, url, kind, enabled)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (name) DO UPDATE SET
         url = EXCLUDED.url,
         kind = EXCLUDED.kind
       RETURNING *`,
      [name, url, kind]
    );
    return this.rowToSource(rows[0]!);
  }

  async listSources(): Promise<SourceRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM sources ORDER BY name`
    );
    return rows.map((r) => this.rowToSource(r));
  }

  async recordSourceFetch(
    sourceId: number,
    stats: {
      candidates: number;
      unique: number;
      error?: string | null;
    }
  ): Promise<void> {
    await this.db.query(
      `UPDATE sources SET
         last_fetched = now(),
         fetch_count = fetch_count + 1,
         candidates = $2,
         unique_candidates = $3,
         working = (
           SELECT COUNT(*)::int FROM proxies
           WHERE source = sources.name AND status IN ('healthy', 'degraded')
         ),
         validation_rate = CASE WHEN $2 > 0 THEN
           ((SELECT COUNT(*)::double precision FROM proxies
             WHERE source = sources.name AND status IN ('healthy', 'degraded')) / $2::double precision)
         ELSE 0 END,
         error_count = error_count + CASE WHEN $4 IS NOT NULL THEN 1 ELSE 0 END,
         last_error = $4,
         last_success = CASE WHEN $4 IS NULL THEN now() ELSE last_success END,
         updated_at = now()
       WHERE id = $1`,
      [sourceId, stats.candidates, stats.unique, stats.error ?? null]
    );
  }

  async setSourceEnabled(name: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE sources SET enabled = $2, updated_at = now() WHERE name = $1`,
      [name, enabled]
    );
  }

  private rowToSource(row: Record<string, unknown>): SourceRecord {
    return {
      id: Number(row.id),
      name: row.name as string,
      url: row.url as string,
      kind: row.kind as string,
      enabled: Boolean(row.enabled),
      last_fetched: (row.last_fetched as Date | null) ?? null,
      last_success: (row.last_success as Date | null) ?? null,
      fetch_count: Number(row.fetch_count),
      candidates: Number(row.candidates),
      unique_candidates: Number(row.unique_candidates),
      working: Number(row.working),
      validation_rate: Number(row.validation_rate),
      error_count: Number(row.error_count),
      last_error: (row.last_error as string | null) ?? null,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }
}