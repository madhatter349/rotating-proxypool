import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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
  getClosedPort,
  startHttpProxy,
  startHttpsEchoTarget,
  startHttpEchoTarget,
  startSocks4Proxy,
  startSocks5Proxy,
} from "./mocks/proxies.js";

const CREDS = { username: "testuser", password: "testpass" };

/**
 * Temporarily replace Math.random with a fixed sequence so weighted selection
 * is deterministic in the test. Returns a restore() function.
 */
function seedRandom(seq: number[]): () => void {
  const real = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)] ?? 0;
  return () => {
    Math.random = real;
  };
}

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
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    tunnelFirstByteTimeoutMs?: number;
    tunnelIdleTimeoutMs?: number;
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
      connectTimeoutMs: opts.connectTimeoutMs ?? 3000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 20000,
      tunnelFirstByteTimeoutMs: opts.tunnelFirstByteTimeoutMs ?? 4000,
      tunnelIdleTimeoutMs: opts.tunnelIdleTimeoutMs ?? 2000,
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
    assert.equal(gateway.stats.tunnelEstablished, 1);
    assert.equal(gateway.stats.success, 1);
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

  it("records end-user first-byte latency for CONNECT, not just handshake latency", async () => {
    let body = Buffer.alloc(0);
    // A plain HTTP origin whose first response byte is delayed: over a CONNECT
    // tunnel there is no TLS, so the first origin byte IS the delayed response.
    const delayed = await startHttpEchoTarget({ delayMs: 300 });
    teardown.push(() => delayed.close());
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, pool, port } = await buildGateway({
      proxies: [{ port: proxy.port }],
    });
    teardown.push(() => gateway.close());

    const { socket, statusCode } = await withTimeout(
      connectViaProxy(
        "127.0.0.1",
        port,
        { host: "127.0.0.1", port: delayed.port },
        CREDS
      ),
      20000
    );
    assert.equal(statusCode, 200);
    socket.write(`GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    await withTimeout(
      new Promise<void>((resolve) => {
        socket.on("data", (c) => (body = Buffer.concat([body, c])));
        socket.on("close", () => resolve());
      }),
      10000
    );
    assert.ok(body.toString("utf8").includes("200"));
    assert.equal(gateway.stats.success, 1);
    const ev = pool.getGatewayEvidence(1);
    assert.ok(
      ev.recentLatenciesMs.length >= 1,
      "a successful CONNECT must record first-byte latency evidence"
    );
    const latency = ev.recentLatenciesMs[0]!;
    assert.ok(
      latency >= 250,
      `recorded ${latency}ms should reflect the delayed origin, not handshake-only time`
    );
  });

  it("records end-user first-byte latency for plain HTTP forwarding", async () => {
    const delayed = await startHttpEchoTarget({ delayMs: 300 });
    teardown.push(() => delayed.close());
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, pool, port } = await buildGateway({
      proxies: [{ port: proxy.port }],
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      httpGetViaProxy("127.0.0.1", port, `http://127.0.0.1:${delayed.port}/hello`, CREDS),
      20000
    );
    assert.equal(res.statusCode, 200);
    const ev = pool.getGatewayEvidence(1);
    assert.ok(
      ev.recentLatenciesMs.length >= 1,
      "plain HTTP forwarding must record first-byte latency evidence"
    );
    assert.ok(
      ev.recentLatenciesMs[0]! >= 250,
      "recorded latency should reflect the delayed origin, not handshake-only time"
    );
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

  it("blocks CONNECT to private/reserved hostnames when blockPrivate is enabled", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: proxy.port }],
      blockPrivate: true,
    });
    teardown.push(() => gateway.close());

    for (const target of [
      { host: "localhost", port: echo.port },
      { host: "metadata.internal", port: 80 },
      { host: "router.local", port: 80 },
    ]) {
      const res = await connectViaProxy("127.0.0.1", port, target, CREDS);
      assert.equal(res.statusCode, 403, `expected 403 for ${target.host}`);
    }
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

  it("recovers by retrying a different upstream after connection refusal", async () => {
    const closedPort = await getClosedPort();
    const good = await startHttpProxy();
    teardown.push(() => good.close());
    const { gateway, port } = await buildGateway({
      // Bad proxy first so the seeded selection picks it on the first attempt.
      proxies: [{ port: closedPort }, { port: good.port }],
    });
    teardown.push(() => gateway.close());

    const restore = seedRandom([0.01]);
    try {
      const res = await withTimeout(
        httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
        20000
      );
      assert.equal(res.statusCode, 200, "should recover via retry onto good upstream");
    } finally {
      restore();
    }
    assert.ok(gateway.stats.upstreamFailures >= 1, "should have recorded a refusal");
    assert.ok(gateway.stats.retryRecovered >= 1, "should have recovered via retry");
  });

  it("recovers by retrying a different upstream after a handshake timeout", async () => {
    const bad = await startHttpProxy({ silentConnect: true });
    const good = await startHttpProxy();
    teardown.push(() => bad.close());
    teardown.push(() => good.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: bad.port }, { port: good.port }],
      connectTimeoutMs: 1000,
    });
    teardown.push(() => gateway.close());

    const restore = seedRandom([0.01]);
    try {
      const res = await withTimeout(
        httpsGetViaProxy("127.0.0.1", port, `https://127.0.0.1:${echo.port}/`, CREDS),
        20000
      );
      assert.equal(res.statusCode, 200, "should recover via retry onto good upstream");
    } finally {
      restore();
    }
    assert.ok(gateway.stats.upstreamFailures >= 1, "should have recorded a handshake timeout");
    assert.ok(gateway.stats.retryRecovered >= 1, "should have recovered via retry");
  });

  it("bounds cumulative retry time by the request timeout", async () => {
    const bad1 = await startHttpProxy({ silentConnect: true });
    const bad2 = await startHttpProxy({ silentConnect: true });
    teardown.push(() => bad1.close());
    teardown.push(() => bad2.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: bad1.port }, { port: bad2.port }],
      maxRetries: 2,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1300,
    });
    teardown.push(() => gateway.close());

    const started = Date.now();
    const res = await withTimeout(
      connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: echo.port }, CREDS),
      5000
    );
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 502);
    assert.ok(elapsed < 1800, `request deadline should bound retries, took ${elapsed}ms`);
    assert.ok(gateway.stats.upstreamFailures >= 2, "both attempted proxies should fail");
  });

  it("returns 502 and records retry exhaustion when all upstreams reject CONNECT", async () => {
    const bad1 = await startHttpProxy({ rejectConnect: true });
    const bad2 = await startHttpProxy({ rejectConnect: true });
    teardown.push(() => bad1.close());
    teardown.push(() => bad2.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: bad1.port }, { port: bad2.port }],
      maxRetries: 1,
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: echo.port }, CREDS),
      15000
    );
    assert.equal(res.statusCode, 502);
    assert.ok(gateway.stats.retryExhausted >= 1, "retries should be exhausted");
    assert.ok(gateway.stats.upstreamFailures >= 2, "each attempt should fail");
  });

  it("penalizes a SOCKS handshake failure and fails closed", async () => {
    const bad = await startSocks5Proxy({ rejectHandshake: true });
    teardown.push(() => bad.close());
    const { gateway, port } = await buildGateway({
      proxies: [{ port: bad.port, protocol: "socks5" }],
      connectTimeoutMs: 1000,
    });
    teardown.push(() => gateway.close());

    const res = await withTimeout(
      connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: echo.port }, CREDS),
      15000
    );
    assert.equal(res.statusCode, 502);
    assert.ok(gateway.stats.upstreamFailures >= 1, "handshake failure recorded");
  });

  it("abandons an upstream that accepts a tunnel but stalls, instead of hanging 30s", async () => {
    const bad = await startHttpProxy({ acceptThenSilent: true });
    teardown.push(() => bad.close());
    const { gateway, pool, port } = await buildGateway({
      proxies: [{ port: bad.port }],
      tunnelFirstByteTimeoutMs: 1200,
      tunnelIdleTimeoutMs: 1000,
    });
    teardown.push(() => gateway.close());

    const started = Date.now();
    const { socket, statusCode } = await withTimeout(
      connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: echo.port }, CREDS),
      10000
    );
    assert.equal(statusCode, 200, "CONNECT is established before the stall");
    await withTimeout(new Promise((r) => socket.once("close", r)), 8000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `should abandon the stall quickly, took ${elapsed}ms`);
    assert.ok(gateway.stats.timeouts >= 1, "should record a tunnel timeout");
    assert.ok(pool.getCooldownMs(1) > Date.now(), "stalled upstream should be cooled down");
    socket.destroy();
  });

  it("penalizes an upstream that closes before the first origin byte", async () => {
    const bad = await startHttpProxy({ acceptThenClose: true });
    teardown.push(() => bad.close());
    const { gateway, port, pool } = await buildGateway({ proxies: [{ port: bad.port }] });
    teardown.push(() => gateway.close());

    const { socket, statusCode } = await withTimeout(
      connectViaProxy("127.0.0.1", port, { host: "127.0.0.1", port: echo.port }, CREDS),
      10000
    );
    assert.equal(statusCode, 200, "the client sees the CONNECT before the upstream closes");
    await withTimeout(new Promise((resolve) => socket.once("close", resolve)), 5000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(pool.getCooldownMs(1) > Date.now(), "early upstream close should arm cooldown");
    assert.ok(gateway.stats.upstreamFailures >= 1, "early close should count as upstream failure");
    assert.equal(gateway.stats.tunnelEstablished, 1);
    assert.equal(gateway.stats.success, 0, "pre-first-byte close is not an end-to-end success");
    assert.equal(gateway.stats.earlyClose, 1);
  });

  it("temporarily cools down an upstream that just failed (excluded from rotation)", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const repo = new FakeRepository();
    await repo.insert(healthyRecord(1, "127.0.0.1", proxy.port, "http"));
    const cfg = makeConfig({ GATEWAY_FAILURE_COOLDOWN_MS: "30000" });
    const validator = new Validator(cfg);
    const pool = new PoolManager(repo, validator, cfg);
    await pool.init();

    await pool.onGatewayFailure(1, "connect ECONNREFUSED");
    assert.ok(pool.getCooldownMs(1) > Date.now(), "cooldown should be armed");
    assert.equal(pool.selectUpstream(), null, "failed proxy is excluded from rotation");
  });

  it("forwards client bytes that arrive in the same packet as CONNECT (pipelined TLS)", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway, port } = await buildGateway({ proxies: [{ port: proxy.port }] });
    teardown.push(() => gateway.close());

    // Send CONNECT and the TLS ClientHello (or here: a plain GET body) in one
    // TCP write. The gateway must forward the leftover bytes to the upstream so
    // nothing sent by the client is lost.
    const result = await withTimeout(
      new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("pipelined CONNECT: timeout"));
        }, 15000);
        let buf = Buffer.alloc(0);
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const text = buf.toString("utf8");
          const headerEnd = text.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const statusLine = text.slice(0, headerEnd).split("\r\n")[0] ?? "";
          const code = Number(statusLine.split(" ")[1] ?? 0);
          if (code !== 200) {
            clearTimeout(timeout);
            socket.destroy();
            return resolve({ statusCode: code, body: "" });
          }
          // The tunnel is established. The origin's echo must contain the
          // "/pipelined" path — proving the GET bytes that were sent in the
          // same TCP write as CONNECT were actually forwarded to the upstream.
          if (text.includes("/pipelined")) {
            clearTimeout(timeout);
            socket.destroy();
            resolve({ statusCode: code, body: text.slice(headerEnd + 4) });
          }
        });
        socket.on("connect", () => {
          const auth = Buffer.from(`${CREDS.username}:${CREDS.password}`).toString("base64");
          socket.write(
            `CONNECT 127.0.0.1:${plainEcho.port} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${plainEcho.port}\r\n` +
              `Proxy-Authorization: Basic ${auth}\r\n\r\n` +
              `GET /pipelined HTTP/1.1\r\nHost: 127.0.0.1:${plainEcho.port}\r\nConnection: close\r\n\r\n`
          );
        });
      }),
      20000
    );
    assert.equal(result.statusCode, 200);
    assert.ok(result.body.includes("/pipelined"), "leftover bytes must be forwarded to the upstream");
    assert.ok(gateway.stats.success >= 1);
  });

  it("shuts down gracefully", async () => {
    const proxy = await startHttpProxy();
    teardown.push(() => proxy.close());
    const { gateway } = await buildGateway({ proxies: [{ port: proxy.port }] });
    await gateway.close();
    assert.ok(true);
  });
});
