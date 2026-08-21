import { buildApi } from "./api/server.js";
import { loadConfig } from "./config.js";
import { closePool, getPool, ping } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { Repository } from "./db/repository.js";
import { GatewayServer } from "./gateway/server.js";
import { PoolManager } from "./pool/manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SourceRegistry } from "./sources/registry.js";
import { Validator } from "./validate/validator.js";

const log = (msg: string) => {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
};

async function main(): Promise<void> {
  const cfg = loadConfig();

  const db = getPool(cfg.env.DATABASE_URL);
  await ping(db);
  log("database connected");
  await migrate(db);
  log("migrations applied");

  const repo = new Repository(db);
  const sources = new SourceRegistry(repo, cfg);
  await sources.ensureSources();
  log(`ensured ${cfg.sources.length} configured sources`);

  // Prepend a self-hosted, J.Crew-shaped validation target. It returns the same
  // product_result JSON shape as the real J.Crew availability endpoint (minus
  // the site-side Akamai geo/bot checks) plus a body marker, so the pool filters
  // out proxies that MITM/TLS-intercept or serve wrong content without ever
  // hammering www.jcrew.com. The marker syntax "url|marker" makes the validator
  // require the marker string in the response body.
  const selfHostedTarget =
    (cfg.env.PUBLIC_API_URL || `http://localhost:${cfg.env.PORT}`) +
    "/api/validate-target|rotating-proxypool-validate";
  const validationTargets = [
    selfHostedTarget,
    ...cfg.validationTargets.filter((t) => !t.includes("/api/validate-target")),
  ];
  const validator = new Validator({ ...cfg, validationTargets });
  const manager = new PoolManager(repo, validator, cfg);
  await manager.init();
  log(`loaded ${manager.getActivePool().length} healthy proxies from database`);

  const gateway = new GatewayServer({
    port: cfg.env.PROXY_PORT,
    authRequired: cfg.env.GATEWAY_AUTH_REQUIRED,
    username: cfg.env.GATEWAY_USERNAME,
    password: cfg.env.GATEWAY_PASSWORD,
    pool: manager,
    connectTimeoutMs: cfg.env.CONNECT_TIMEOUT_MS,
    requestTimeoutMs: cfg.env.GATEWAY_REQUEST_TIMEOUT_MS,
    tunnelFirstByteTimeoutMs: cfg.env.TUNNEL_FIRST_BYTE_TIMEOUT_MS,
    tunnelIdleTimeoutMs: cfg.env.TUNNEL_IDLE_TIMEOUT_MS,
    maxHeaderBytes: 16 * 1024,
    maxRetries: 2,
    maxConnections: 1000,
    blockPrivate: true,
    log,
  });
  const proxyPort = await gateway.listen();
  log(`proxy gateway listening on :${proxyPort}`);

  // Restore persisted gateway counters so restarts do not wipe dashboard telemetry.
  const persisted = await repo.loadGatewayMetrics().catch(() => null);
  if (persisted) {
    gateway.restoreStats({
      connections: Number(persisted.connections ?? 0),
      connectRequests: Number(persisted.connect_requests ?? 0),
      httpRequests: Number(persisted.http_requests ?? 0),
      authFailures: Number(persisted.auth_failures ?? 0),
      upstreamFailures: Number(persisted.upstream_failures ?? 0),
      retries: Number(persisted.retries ?? 0),
      tunnelEstablished: Number(persisted.tunnel_established ?? 0),
      success: Number(persisted.success ?? 0),
      earlyClose: Number(persisted.early_close ?? 0),
      totalClientRequests: Number(persisted.total_client_requests ?? 0),
      firstAttemptSuccess: Number(persisted.first_attempt_success ?? 0),
      retryRecovered: Number(persisted.retry_recovered ?? 0),
      retryExhausted: Number(persisted.retry_exhausted ?? 0),
      timeouts: Number(persisted.timeouts ?? 0),
      requestDurations: Array.isArray(persisted.request_durations_ms)
        ? (persisted.request_durations_ms as number[])
        : [],
      requestsByProtocol:
        persisted.requests_by_protocol && typeof persisted.requests_by_protocol === "object"
          ? (persisted.requests_by_protocol as Record<string, number>)
          : {},
      startedAt: String(persisted.started_at ?? new Date().toISOString()),
    });
    log("restored persisted gateway metrics");
  }

  const api = await buildApi({ repo, pool: manager, sources, gateway, cfg });
  await api.listen({ port: cfg.env.PORT, host: "0.0.0.0" });
  log(`api/dashboard listening on :${cfg.env.PORT}`);

  const scheduler = new Scheduler({
    sources,
    pool: manager,
    discoveryIntervalMs: cfg.env.DISCOVERY_INTERVAL_MS,
    validateNewIntervalMs: cfg.env.VALIDATE_NEW_INTERVAL_MS,
    recheckIntervalMs: cfg.env.RECHECK_INTERVAL_MS,
    retestIntervalMs: cfg.env.QUARANTINE_RETEST_INTERVAL_MS,
    cleanupIntervalMs: cfg.env.CLEANUP_INTERVAL_MS,
    discoveryEnabled: cfg.env.DISCOVERY_ENABLED,
    log,
  });

  // Kick off an immediate discovery + validation so the pool fills quickly.
  if (cfg.env.DISCOVERY_ENABLED) {
    const results = await sources.refreshAll();
    log(
      `initial discovery: ${results.filter((r) => r.ok).length}/${results.length} sources ok`
    );
  }
  const first = await manager.runValidationPass();
  log(`initial validation: ${first.ok}/${first.checked} ok`);

  scheduler.start();

  const flushMetrics = async () => {
    try {
      await repo.saveGatewayMetrics({
        connections: gateway.stats.connections,
        connectRequests: gateway.stats.connectRequests,
        httpRequests: gateway.stats.httpRequests,
        authFailures: gateway.stats.authFailures,
        upstreamFailures: gateway.stats.upstreamFailures,
        retries: gateway.stats.retries,
        tunnelEstablished: gateway.stats.tunnelEstablished,
        success: gateway.stats.success,
        earlyClose: gateway.stats.earlyClose,
        totalClientRequests: gateway.stats.totalClientRequests,
        firstAttemptSuccess: gateway.stats.firstAttemptSuccess,
        retryRecovered: gateway.stats.retryRecovered,
        retryExhausted: gateway.stats.retryExhausted,
        timeouts: gateway.stats.timeouts,
        requestDurations: gateway.stats.requestDurations,
        requestsByProtocol: gateway.stats.requestsByProtocol,
        startedAt: gateway.stats.startedAt,
      });
    } catch {
      // non-fatal: metrics persistence is best-effort
    }
  };
  const flushTimer = setInterval(flushMetrics, 60_000);
  flushTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    scheduler.stop();
    clearInterval(flushTimer);
    await flushMetrics();
    await api.close();
    await gateway.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});