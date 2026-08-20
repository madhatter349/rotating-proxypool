import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PoolManager } from "../src/pool/manager.js";
import { Validator } from "../src/validate/validator.js";
import { FakeRepository, healthyRecord } from "./helpers/fakeRepo.js";
import { makeConfig, withTimeout } from "./helpers/testEnv.js";
import {
  getClosedPort,
  startHttpProxy,
  startHttpsEchoTarget,
} from "./mocks/proxies.js";
import { MOCK_CERT } from "./mocks/cert.js";

describe("pool manager lifecycle", () => {
  let echo: Awaited<ReturnType<typeof startHttpsEchoTarget>>;
  let echoUrl: string;
  const teardown: Array<() => Promise<void>> = [];

  before(async () => {
    echo = await startHttpsEchoTarget();
    teardown.push(() => echo.close());
    echoUrl = `https://127.0.0.1:${echo.port}/`;
  });

  after(async () => {
    for (const fn of teardown) await fn();
  });

  async function buildManager() {
    const repo = new FakeRepository();
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const validator = new Validator(cfg, { tlsCa: MOCK_CERT });
    const pool = new PoolManager(repo, validator, cfg);
    await pool.init();
    return { repo, pool, cfg };
  }

  it("validates pending candidates into healthy proxies", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { repo, pool } = await buildManager();
    await repo.insert({
      ...healthyRecord(1, "127.0.0.1", proxy.port, "http"),
      status: "pending",
      score: 0,
    });
    const res = await withTimeout(pool.runValidationPass(), 20000);
    assert.equal(res.checked, 1);
    assert.equal(res.ok, 1);
    const record = await repo.getProxy(1);
    assert.equal(record?.status, "healthy");
    assert.ok((record?.score ?? 0) > 0);
    assert.equal(pool.getActivePool().length, 1);
  });

  it("quarantines repeatedly failing gateway upstreams", async () => {
    const proxy = await startHttpProxy({ destroyAfterConnect: true });
    teardown.push(() => proxy.close());
    const { repo, pool } = await buildManager();
    await repo.insert(healthyRecord(1, "127.0.0.1", proxy.port, "http"));

    await pool.onGatewayFailure(1, "test failure 1");
    assert.equal((await repo.getProxy(1))?.status, "degraded");
    await pool.onGatewayFailure(1, "test failure 2");
    const after = await repo.getProxy(1);
    assert.equal(after?.status, "quarantined");
    assert.ok(after?.quarantined_until && after.quarantined_until.getTime() > Date.now());
    assert.equal(pool.getActivePool().length, 0);
    assert.equal(pool.getRecentFailures().length, 2);
  });

  it("recovers a quarantined proxy via retest when it works again", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { repo, pool } = await buildManager();
    const rec = healthyRecord(1, "127.0.0.1", proxy.port, "http");
    await repo.insert({
      ...rec,
      status: "quarantined",
      quarantined_until: new Date(Date.now() - 1000),
      score: 10,
    });

    const res = await withTimeout(pool.runQuarantineRetestPass(), 20000);
    assert.equal(res.checked, 1);
    assert.equal(res.recovered, 1);
    const after = await repo.getProxy(1);
    assert.equal(after?.status, "healthy");
    assert.equal(after?.quarantined_until, null);
  });

  it("marks dead pending proxies that fail validation repeatedly", async () => {
    const deadPort = await getClosedPort();
    const { repo, pool } = await buildManager();
    const rec = healthyRecord(1, "127.0.0.1", deadPort, "http");
    await repo.insert({ ...rec, status: "pending", score: 0 });

    await pool.runValidationPass();
    assert.equal((await repo.getProxy(1))?.status, "pending");
    await pool.runValidationPass();
    const after = await repo.getProxy(1);
    assert.equal(after?.status, "dead");
    assert.equal(after?.score, 0);
  });

  it("sends quarantined proxies to dead when retest fails", async () => {
    const deadPort = await getClosedPort();
    const { repo, pool } = await buildManager();
    const rec = healthyRecord(1, "127.0.0.1", deadPort, "http");
    await repo.insert({
      ...rec,
      status: "quarantined",
      quarantined_until: new Date(Date.now() - 1000),
      score: 10,
    });
    await pool.runQuarantineRetestPass();
    assert.equal((await repo.getProxy(1))?.status, "dead");
  });

  it("marks stale discovered/pending proxies dead during cleanup", async () => {
    const { repo, pool } = await buildManager();
    const old = new Date(Date.now() - 2 * 86400_000);
    const rec = healthyRecord(1, "127.0.0.1", 9999, "http");
    await repo.insert({
      ...rec,
      status: "discovered",
      score: 0,
      last_seen: old,
      first_seen: old,
    });
    const res = await pool.runCleanup();
    assert.equal(res.dead, 1);
    assert.equal((await repo.getProxy(1))?.status, "dead");
  });

  it("gateway success clears quarantine and refreshes the pool", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { repo, pool } = await buildManager();
    await repo.insert({
      ...healthyRecord(1, "127.0.0.1", proxy.port, "http"),
      status: "quarantined",
      quarantined_until: new Date(Date.now() + 60000),
      score: 10,
    });
    await pool.onGatewaySuccess(1);
    const after = await repo.getProxy(1);
    assert.equal(after?.status, "healthy");
    assert.equal(after?.quarantined_until, null);
    assert.equal(pool.getActivePool().length, 1);
  });
});