import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { adminAuthConfigured, gatewayAuthConfigured } from "../config.js";
import type { Repository } from "../db/repository.js";
import type { GatewayServer } from "../gateway/server.js";
import type { PoolManager } from "../pool/manager.js";
import type { SourceRegistry } from "../sources/registry.js";

const dashboardPath = fileURLToPath(
  new URL("../dashboard/index.html", import.meta.url)
);

interface AdminState {
  repo: Repository;
  pool: PoolManager;
  sources: SourceRegistry;
  gateway: GatewayServer;
  cfg: AppConfig;
}

export async function buildApi(state: AdminState): Promise<Fastify.FastifyInstance> {
  const app = Fastify({ logger: false });

  const dashboardHtml = await readFile(dashboardPath, "utf8");

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(dashboardHtml);
  });

  app.get("/health", async () => ({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    version: "1.0.0",
    time: new Date().toISOString(),
  }));

  app.get("/ready", async (_req, reply) => {
    try {
      await state.repo.totalCount();
      return {
        status: "ready",
        db: true,
        poolLoaded: state.pool.getActivePool().length >= 0,
        healthyCount: state.pool.getActivePool().length,
      };
    } catch {
      return reply.code(503).send({ status: "not ready", db: false });
    }
  });

  app.get("/stats", async () => buildStats(state));

  // Public open validation endpoint. Returns the requester's source IP plus a
  // body marker so the pool can validate that a proxy tunnels clean HTTPS and
  // does not MITM (a proxy that intercepts or serves blocked content will not
  // echo this exact marker). Simple open format (like ipify/httpbin/ip) so it
  // doubles as a manual test tool. Protected against DDoS by a per-source-IP
  // rate limit.
  const ipHits = new Map<string, number[]>();
  const rateLimitPerMin = state.cfg.env.VALIDATE_RATE_LIMIT_PER_MIN;
  app.get("/api/validate", async (req, reply) => {
    const ip = req.socket.remoteAddress ?? "0.0.0.0";
    // Sliding-window rate limit: allow `rateLimitPerMin` requests per IP per min.
    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (ipHits.get(ip) ?? []).filter((t) => t > windowStart);
    if (hits.length >= rateLimitPerMin) {
      const retryAfter = Math.ceil((hits[0]! + 60_000 - now) / 1000);
      return reply
        .code(429)
        .header("retry-after", String(Math.max(1, retryAfter)))
        .send({ error: "rate limited", retryAfter });
    }
    hits.push(now);
    ipHits.set(ip, hits);
    // Prune stale buckets to bound memory.
    if (ipHits.size > 10_000) {
      for (const [k, v] of ipHits) {
        if (!v.some((t) => t > windowStart)) ipHits.delete(k);
      }
    }
    return reply
      .header("content-type", "application/json")
      .header("x-proxy-pool-validate", "rotating-proxypool-validate")
      .send({
        ip,
        origin: ip,
        marker: "rotating-proxypool-validate",
        service: "rotating-proxypool",
        time: new Date().toISOString(),
      });
  });

  // Public connection metadata for the docs site. No secrets: reports host/port,
  // whether auth is configured, and the gateway username (never the password).
  app.get("/api-meta", async () => ({
    service: "rotating-proxypool",
    version: "1.0.0",
    gateway: {
      host: state.cfg.env.PUBLIC_PROXY_HOST || state.gateway.host || "127.0.0.1",
      port:
        state.cfg.env.PUBLIC_PROXY_PORT > 0
          ? state.cfg.env.PUBLIC_PROXY_PORT
          : state.gateway.port,
      authRequired: gatewayAuthConfigured(state.cfg),
      username: state.cfg.env.GATEWAY_USERNAME,
      passwordConfigured: state.cfg.env.GATEWAY_PASSWORD.length > 0,
    },
    api: {
      baseUrl: state.cfg.env.PUBLIC_API_URL || "",
    },
    admin: {
      configured: adminAuthConfigured(state.cfg),
    },
  }));

  const admin = async (req: Fastify.FastifyRequest, reply: Fastify.FastifyReply) => {
    if (!adminAuthConfigured(state.cfg)) {
      return reply.code(503).send({ error: "admin API not configured" });
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (token !== state.cfg.env.ADMIN_TOKEN) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.addHook("preHandler", async (req, reply) => {
    if (
      req.url.startsWith("/api/") &&
      !req.url.startsWith("/api-meta") &&
      !req.url.startsWith("/api/validate")
    ) {
      await admin(req, reply);
      if (reply.sent) return;
    }
  });

  app.get("/api/proxies", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const proxies = await state.repo.listProxies({
      status: (q.status as never) ?? "all",
      protocol: (q.protocol as never) ?? "all",
      minScore: q.minScore ? Number(q.minScore) : undefined,
      limit: Number(q.limit ?? 100),
      offset: Number(q.offset ?? 0),
    });
    return { count: proxies.length, proxies };
  });

  app.get("/api/proxies/active", async () => {
    const proxies = state.pool.getActivePool();
    return { count: proxies.length, proxies };
  });

  app.get("/api/sources", async () => {
    const sources = await state.sources.getSources();
    return { count: sources.length, sources };
  });

  app.post("/api/refresh", async () => {
    const results = await state.sources.refreshAll();
    const ok = results.filter((r) => r.ok).length;
    return { ok, failed: results.length - ok, results };
  });

  app.post("/api/check", async () => {
    const validation = await state.pool.runValidationPass();
    const recheck = await state.pool.runRecheckPass();
    const retest = await state.pool.runQuarantineRetestPass();
    return { validation, recheck, retest };
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "not found" });
  });

  app.setErrorHandler((err, _req, reply) => {
    // eslint-disable-next-line no-console
    console.error("api error:", err);
    reply.code(500).send({ error: "internal error" });
  });

  return app;
}

async function buildStats(state: AdminState) {
  const [byStatus, byProtocol, total, { validationSuccessRate, totalChecks }, sources, healthy] =
    await Promise.all([
      state.repo.countByStatus(),
      state.repo.countByProtocol(),
      state.repo.totalCount(),
      state.repo.stats(),
      state.repo.listSources(),
      state.pool.getActivePool(),
    ]);

  const latency = healthy.map((p) => p.latency_ms).filter((l): l is number => l != null).sort((a, b) => a - b);
  const median = latency.length
    ? latency[Math.floor(latency.length / 2)] ?? null
    : null;

  const lastRefresh = state.pool.getLastRefreshAt();
  const recentFailures = state.pool.getRecentFailures().slice(0, 20);

  const topProxies = [...healthy]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.latency_ms ?? Number.POSITIVE_INFINITY) -
          (b.latency_ms ?? Number.POSITIVE_INFINITY)
    )
    .slice(0, 10)
    .map((p) => ({
      host: p.host,
      port: p.port,
      protocol: p.protocol,
      score: p.score,
      latency_ms: p.latency_ms,
      success_rate: p.success_rate,
      exit_ip: p.exit_ip,
    }));

  return {
    total,
    byStatus,
    byProtocol,
    activePool: healthy.length,
    topProxies,
    medianLatencyMs: median,
    validationSuccessRate,
    totalChecks,
    lastRefresh,
    recentFailures,
    gateway: state.gateway.stats,
    gatewayReliability: gatewayReliability(state.gateway),
    selection: state.pool.getSelectionStats(),
    gatewaySources: state.pool.getSourceStats(),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      enabled: s.enabled,
      last_fetched: s.last_fetched,
      last_success: s.last_success,
      fetch_count: s.fetch_count,
      candidates: s.candidates,
      unique_candidates: s.unique_candidates,
      working: s.working,
      validation_rate: s.validation_rate,
      error_count: s.error_count,
      last_error: s.last_error,
    })),
  };
}

function pct(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function gatewayReliability(gateway: GatewayServer): object {
  const g = gateway.stats;
  const d = g.requestDurations;
  const totalRequests = g.totalClientRequests;
  const successes = g.success;
  return {
    totalRequests,
    // HTTPS CONNECT traffic is opaque to the gateway after the tunnel opens;
    // this is a transport-level first-origin-byte signal, not an HTTP 2xx rate.
    originFirstByteSuccessRate: totalRequests
      ? +(successes / totalRequests).toFixed(4)
      : null,
    // Backward-compatible alias for existing API consumers.
    clientSuccessRate: totalRequests ? +(successes / totalRequests).toFixed(4) : null,
    tunnelEstablished: g.tunnelEstablished,
    tunnelSuccessRate: g.tunnelEstablished
      ? +(successes / g.tunnelEstablished).toFixed(4)
      : null,
    earlyClose: g.earlyClose,
    firstAttemptSuccessRate: totalRequests
      ? +(g.firstAttemptSuccess / totalRequests).toFixed(4)
      : null,
    retryRecoveryRate: totalRequests ? +(g.retryRecovered / totalRequests).toFixed(4) : null,
    retryExhausted: g.retryExhausted,
    timeouts: g.timeouts,
    avgLatencyMs: avg(d),
    p50Ms: pct(d, 50),
    p90Ms: pct(d, 90),
    p95Ms: pct(d, 95),
    maxLatencyMs: d.length ? Math.max(...d) : null,
    requestsByProtocol: g.requestsByProtocol,
  };
}

// re-export for tests
export { dashboardPath };
