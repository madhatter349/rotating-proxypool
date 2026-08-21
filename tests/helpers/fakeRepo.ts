import type {
  ProxyCandidate,
  ProxyProtocol,
  ProxyRecord,
  ProxyStatus,
  SourceRecord,
  ValidationResult,
} from "../../src/types.js";

/**
 * An in-memory stand-in for the postgres Repository, used to run the pool
 * manager and gateway deterministically without a database.
 * It structurally implements the subset of Repository the manager relies on.
 */
export class FakeRepository {
  private nextId = 1;
  readonly proxies = new Map<number, ProxyRecord>();
  readonly sources = new Map<number, SourceRecord>();
  healthyQueryCount = 0;

  async insert(record: Omit<ProxyRecord, "id">): Promise<ProxyRecord> {
    const full: ProxyRecord = { id: this.nextId++, ...record };
    this.proxies.set(full.id, full);
    return full;
  }

  private get now() {
    return new Date();
  }

  // ---- Repository-compatible methods ----

  async getHealthyProxies(): Promise<ProxyRecord[]> {
    this.healthyQueryCount++;
    return [...this.proxies.values()]
      .filter((p) => p.status === "healthy")
      .sort((a, b) => b.score - a.score);
  }

  async getProxy(id: number): Promise<ProxyRecord | null> {
    return this.proxies.get(id) ?? null;
  }

  async getPending(): Promise<ProxyRecord[]> {
    return [...this.proxies.values()].filter((p) =>
      ["pending", "discovered"].includes(p.status)
    );
  }

  async getProxiesByStatus(statuses: ProxyStatus[]): Promise<ProxyRecord[]> {
    return [...this.proxies.values()].filter((p) => statuses.includes(p.status));
  }

  async getQuarantinedDue(): Promise<ProxyRecord[]> {
    return [...this.proxies.values()].filter(
      (p) =>
        p.status === "quarantined" &&
        (!p.quarantined_until || p.quarantined_until.getTime() <= Date.now())
    );
  }

  async markDead(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let n = 0;
    for (const p of this.proxies.values()) {
      if (
        (p.status === "discovered" || p.status === "pending") &&
        p.last_seen.getTime() < cutoff
      ) {
        p.status = "dead";
        p.score = 0;
        n++;
      }
    }
    return n;
  }

  async applyValidationResult(
    proxyId: number,
    result: ValidationResult
  ): Promise<ProxyRecord | null> {
    const p = this.proxies.get(proxyId);
    if (!p) return null;
    p.last_checked = this.now;
    p.supports_https = result.supportsHttps;
    p.latency_ms = result.ok ? result.latencyMs : null;
    if (result.exitIp) p.exit_ip = result.exitIp;
    if (result.ok) {
      p.success_count += 1;
      p.consecutive_failures = 0;
      p.last_success = this.now;
      if (result.protocol) p.protocol = result.protocol;
    } else {
      p.failure_count += 1;
      p.consecutive_failures += 1;
      p.last_error = result.error;
    }
    return p;
  }

  async recordSuccess(proxy: ProxyRecord): Promise<ProxyRecord> {
    const p = this.proxies.get(proxy.id);
    if (!p) return proxy;
    p.success_count += 1;
    p.consecutive_failures = 0;
    p.last_success = this.now;
    p.last_checked = this.now;
    return p;
  }

  async recordFailure(
    proxy: ProxyRecord,
    error?: string | null
  ): Promise<ProxyRecord> {
    const p = this.proxies.get(proxy.id);
    if (!p) return proxy;
    p.failure_count += 1;
    p.consecutive_failures += 1;
    p.last_checked = this.now;
    if (error) p.last_error = error.slice(0, 300);
    return p;
  }

  async setStatus(
    proxyId: number,
    status: ProxyStatus,
    extras?: { quarantinedUntil?: Date | null; lastError?: string | null }
  ): Promise<ProxyRecord | null> {
    const p = this.proxies.get(proxyId);
    if (!p) return null;
    p.status = status;
    if (extras?.quarantinedUntil !== undefined) p.quarantined_until = extras.quarantinedUntil;
    if (extras?.lastError != null) p.last_error = extras.lastError;
    return p;
  }

  async updateScore(proxyId: number, score: number): Promise<void> {
    const p = this.proxies.get(proxyId);
    if (p) p.score = score;
  }

  async clearProbe(proxyId: number): Promise<void> {
    const p = this.proxies.get(proxyId);
    if (p) p.probe = false;
  }

  async getByKey(
    host: string,
    port: number,
    protocol: ProxyProtocol
  ): Promise<{ id: number; status: string } | null> {
    for (const p of this.proxies.values()) {
      if (p.host === host && p.port === port && p.protocol === protocol) {
        return { id: p.id, status: p.status };
      }
    }
    return null;
  }

  async upsertCandidate(candidate: ProxyCandidate): Promise<ProxyRecord> {
    const protocol = candidate.protocol === "auto" ? "http" : candidate.protocol;
    for (const p of this.proxies.values()) {
      if (
        p.host === candidate.host &&
        p.port === candidate.port &&
        p.protocol === protocol
      ) {
        p.last_seen = this.now;
        if (p.status === "dead") p.status = "pending";
        return p;
      }
    }
    return this.insert({
      host: candidate.host,
      port: candidate.port,
      protocol: protocol as ProxyProtocol,
      source: candidate.source,
      first_seen: this.now,
      last_seen: this.now,
      last_checked: null,
      last_success: null,
      success_count: 0,
      failure_count: 0,
      consecutive_failures: 0,
      latency_ms: null,
      success_rate: 0,
      exit_ip: null,
      country: null,
      supports_https: false,
      score: 0,
      status: "pending",
      quarantined_until: null,
      last_error: null,
      probe: candidate.protocol === "auto",
    });
  }

  // ---- source methods (for SourceRegistry) ----
  async ensureSource(
    name: string,
    url: string,
    kind: string
  ): Promise<SourceRecord> {
    for (const src of this.sources.values()) {
      if (src.name === name) {
        src.url = url;
        src.kind = kind;
        return src;
      }
    }
    const id = this.nextId++;
    const record: SourceRecord = {
      id,
      name,
      url,
      kind,
      enabled: true,
      last_fetched: null,
      last_success: null,
      fetch_count: 0,
      candidates: 0,
      unique_candidates: 0,
      working: 0,
      validation_rate: 0,
      error_count: 0,
      last_error: null,
      created_at: this.now,
      updated_at: this.now,
    };
    this.sources.set(id, record);
    return record;
  }

  async listSources(): Promise<SourceRecord[]> {
    return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async recordSourceFetch(
    sourceId: number,
    stats: { candidates: number; unique: number; error?: string | null }
  ): Promise<void> {
    const src = this.sources.get(sourceId);
    if (!src) return;
    src.last_fetched = this.now;
    src.fetch_count += 1;
    src.candidates = stats.candidates;
    src.unique_candidates = stats.unique;
    if (stats.error != null) {
      src.error_count += 1;
      src.last_error = stats.error;
    } else {
      src.last_success = this.now;
      src.last_error = null;
    }
  }

  // ---- unused by manager but needed for structural parity ----
  async totalCount(): Promise<number> {
    return this.proxies.size;
  }
  async countByStatus(): Promise<Record<ProxyStatus, number>> {
    const out: Record<ProxyStatus, number> = {
      discovered: 0,
      pending: 0,
      healthy: 0,
      degraded: 0,
      quarantined: 0,
      dead: 0,
    };
    for (const p of this.proxies.values()) out[p.status] += 1;
    return out;
  }
  async countByProtocol(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of this.proxies.values()) out[p.protocol] = (out[p.protocol] ?? 0) + 1;
    return out;
  }
  async stats(): Promise<{
    medianLatencyMs: number | null;
    validationSuccessRate: number;
    totalChecks: number;
  }> {
    return { medianLatencyMs: null, validationSuccessRate: 0, totalChecks: this.proxies.size };
  }
}

export type FakeRepo = FakeRepository;

/** Helper: build a ProxyRecord for a mock proxy quickly. */
export function healthyRecord(
  id: number,
  host: string,
  port: number,
  protocol: ProxyProtocol = "http"
): ProxyRecord {
  return {
    id,
    host,
    port,
    protocol,
    source: "test",
    first_seen: new Date(),
    last_seen: new Date(),
    last_checked: new Date(),
    last_success: new Date(),
    success_count: 10,
    failure_count: 0,
    consecutive_failures: 0,
    latency_ms: 80,
    success_rate: 1,
    exit_ip: null,
    country: null,
    supports_https: true,
    score: 95,
    status: "healthy",
    quarantined_until: null,
    last_error: null,
    probe: false,
  };
}