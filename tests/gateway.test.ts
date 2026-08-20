import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GatewayServer } from "../src/gateway/server.js";
import { PoolManager } from "../src/pool/manager.js";
import { Validator } from "../src/validate/validator.js";
import { FakeRepository, healthyRecord } from "./helpers/fakeRepo.js";
import { makeConfig, withTimeout } from "./helpers/testEnv.js";
import {
  connectViaProxy,
  httpGetViaProxy,
  httpsGetViaProxy,
} from "./helpers/client.js";
import {
  startHttpProxy,
  startHttpsEchoTarget,
  startHttpEchoTarget,
  startSocks4Proxy,
  startSocks5Proxy,
} from "./mocks/proxies.js";

const CREDS = { username: "testuser", password: "testpass" };

describe("gateway", () => {
  let echo: Awaited<ReturnType<typeof startHttpsEchoTarget>>;
  let plainEcho: Awaited<ReturnType<typeof startHttpEchoTarget>>;
  const teardown: Array<() => Promise<void>> = [];

  before(async () => {
    echo = await startHttpsEchoTarget();
    plainEcho = await startHttpEchoTarget();
    teardown.push(() => echo.close());
    teardown.push(() => plainEcho.close());
  });

  after(async () => {
    for (const fn of teardown) await fn();
  });

  async function buildGateway(opts: {
    proxies?: Array<{ port: number; protocol?: "http" | "socks4" | "socks5" }>;
    blockPrivate?: boolean;
    maxRetries?: number;
  } = {}) {
    const repo = new FakeRepository();
    for (const [i, p] of (opts.proxies ?? []).entries()) {
      const rec = healthyRecord(i + 1, "127.0.0.1", p.port, p.protocol ?? "http");
      await repo.insert(rec);
    }
    const cfg = makeConfig({
      VALIDATION_TARGETS: `https://127.0.0.1:${echo.port}/`,
    });
    const validator = new Validator(cfg);
    const pool = new PoolManager(repo, validator, cfg);
    await pool.init();
    const gateway = new GatewayServer({
      port: 0,
      authRequired: true,
      username: CREDS.username,
      password: CREDS.password,
      pool,
      connectTimeoutMs: 3000,
      requestTimeoutMs: 20000,
      maxHeaderBytes: 16 * 1024,
      maxRetries: opts.maxRetries ?? 2,
      maxConnections: 100,
      blockPrivate: opts.blockPrivate ?? false,
      log: () => undefined,
    });
    const port = await gateway.listen();
    return { gateway, pool, repo, port };
  }

  it("rejects CONNECT without credentials with 407", async () => {
    const { gateway, port } = await buildGateway();
    teardown.push(() => gateway.close());
    const res = await connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: 1 });
    assert.equal(res.statusCode, 407);
  });

  it("rejects CONNECT with wrong credentials with 407", async () => {
    const { gateway, port } = await buildGateway();
    teardown.push(() => gateway.close());
    const res = await connectViaProxy(
      "127.0.0.1",
      port,
      { host: "127.0.0.1", port: 1 },
      { username: "nope", password: "nope" }
    );
    assert.equal(res.statusCode, 407);
  });

  it("tunnels HTTPS through a healthy upstream proxy", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({ proxies: [{ port: proxy.port }] });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("127.0.0.1"));
    assert.ok(gateway.stats.connectRequests >= 1);
    assert.equal(gateway.stats.authFailures, 0);
  });

  it("forwards plain HTTP using absolute-URI form", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({ proxies: [{ port: proxy.port }] });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpGetViaProxy("127.0.0.1", port, `http://127.0.0.1:${plainEcho.port}/hello`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("/hello"));
    assert.ok(gateway.stats.httpRequests >= 1);
  });

  it("blocks CONNECT to private IPs when blockPrivate is enabled", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: proxy.port }],
      blockPrivate: true,
    });
    teardown.push(() => gateway.close());

    const res = await connectViaProxy(
      "127.0.0.1",
      port,
      { host: "127.0.0.1", port: echo.port },
      CREDS
    );
    assert.equal(res.statusCode, 403);
  });

  it("rotates across multiple healthy upstreams", async () => {
    const p1 = await startHttpProxy();
    const p2 = await startHttpProxy();
    teardown.push(() => p1.close());
    teardown.push(() => p2.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: p1.port }, { port: p2.port }],
    });
    teardown.push(() => gateway.close());

    for (let i = 0; i < 10; i++) {
      const res = await withTimeout(
        httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
        20000
      );
      assert.equal(res.statusCode, 200);
    }
    assert.ok(
      p1.connectionCount() > 0 && p2.connectionCount() > 0,
      `both upstreams should be used (p1=${p1.connectionCount()}, p2=${p2.connectionCount()})`
    );
  });

  it("retries on upstream failure and succeeds via a healthy proxy", async () => {
    const bad = await startHttpProxy({ destroyAfterConnect: true });
    const good = await startHttpProxy();
    teardown.push(() => bad.close());
    teardown.push(() => good.close());
    const { gateway, port, pool } = await buildGateway({
      proxies: [{ port: bad.port }, { port: good.port }],
    });
    teardown.push(() => gateway.close());

    let ok = 0;
    for (let i = 0; i < 6; i++) {
      const res = await withTimeout(
        httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
        25000
      );
      if (res.statusCode === 200) ok++;
    }
    assert.ok(ok >= 5, `most requests should succeed via retry (got ${ok}/6)`);
    assert.ok(gateway.stats.upstreamFailures > 0, "should have recorded upstream failures");
    assert.ok(gateway.stats.retries > 0, "should have retried");
    // The bad proxy should have been degraded/quarantined and dropped from the pool.
    const badRecord = [...pool.getActivePool()].find(
      (p) => p.port === bad.port
    );
    assert.equal(badRecord, undefined);
  });

  it("returns 502 when no upstream succeeds", async () => {
    const bad = await startHttpProxy({ destroyAfterConnect: true });
    teardown.push(() => bad.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: bad.port }],
      maxRetries: 1,
    });
    teardown.push(() => gateway.close());

    const res = await connectViaProxy(
      "127.0.0.1",
      port,
      { host: "127.0.0.1", port: echo.port },
      CREDS
    );
    assert.equal(res.statusCode, 502);
  });

  it("returns 502 when the pool is empty", async () => {
    const { gateway, port } = await buildGateway({ proxies: [] });
    teardown.push(() => gateway.close());
    const res = await connectViaProxy(
      "127.0.0.1",
      port,
      { host: "127.0.0.1", port: echo.port },
      CREDS
    );
    assert.equal(res.statusCode, 502);
  });

  it("tunnels HTTPS through a healthy SOCKS5 upstream", async () => {
    const proxy = await startSocks5Proxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: proxy.port, protocol: "socks5" }],
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    assert.equal(gateway.stats.connectRequests, 1);
  });

  it("tunnels HTTPS through a healthy SOCKS4 upstream", async () => {
    const proxy = await startSocks4Proxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: proxy.port, protocol: "socks4" }],
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    assert.equal(gateway.stats.connectRequests, 1);
  });

  it("forwards plain HTTP through a SOCKS5 upstream", async () => {
    const proxy = await startSocks5Proxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: proxy.port, protocol: "socks5" }],
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpGetViaProxy("127.0.0.1", port, `http://127.0.0.1:${plainEcho.port}/hello`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("/hello"));
    assert.equal(gateway.stats.httpRequests, 1);
  });

  it("shuts down gracefully", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway } = await buildGateway({ proxies: [{ port: proxy.port }] });
    await gateway.close();
    assert.ok(true);
  });
});