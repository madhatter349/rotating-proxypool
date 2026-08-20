import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { adminAuthConfigured } from "../config.js";
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
  const app = Fastify({ logger: false, disableRequestLogging: true });

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
    if (req.url.startsWith("/api/")) {
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

  return {
    total,
    byStatus,
    byProtocol,
    activePool: healthy.length,
    medianLatencyMs: median,
    validationSuccessRate,
    totalChecks,
    lastRefresh,
    recentFailures,
    gateway: state.gateway.stats,
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

// re-export for tests
export { dashboardPath };