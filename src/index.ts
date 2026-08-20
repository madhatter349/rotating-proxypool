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

  const validator = new Validator(cfg);
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
    requestTimeoutMs: 120_000,
    maxHeaderBytes: 16 * 1024,
    maxRetries: 2,
    maxConnections: 1000,
    blockPrivate: true,
    log,
  });
  const proxyPort = await gateway.listen();
  log(`proxy gateway listening on :${proxyPort}`);

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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    scheduler.stop();
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