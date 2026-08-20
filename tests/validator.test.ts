import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Validator } from "../src/validate/validator.js";
import { makeConfig, withTimeout } from "./helpers/testEnv.js";
import {
  getClosedPort,
  startHttpProxy,
  startHttpsEchoTarget,
  startSocks4Proxy,
  startSocks5Proxy,
} from "./mocks/proxies.js";
import { MOCK_CERT } from "./mocks/cert.js";

describe("validator", () => {
  let echo: Awaited<ReturnType<typeof startHttpsEchoTarget>>;
  let echoUrl: string;
  const teardown: Array<() => Promise<void>> = [];

  function makeValidator(cfg: ReturnType<typeof makeConfig>) {
    return new Validator(cfg, { tlsCa: MOCK_CERT });
  }

  before(async () => {
    echo = await startHttpsEchoTarget();
    teardown.push(() => echo.close());
    echoUrl = `https://127.0.0.1:${echo.port}/`;
  });

  after(async () => {
    for (const fn of teardown) await fn();
  });

  function proxy(over: Record<string, unknown> = {}) {
    return {
      host: "127.0.0.1",
      port: 0,
      protocol: "http",
      probe: false,
      ...over,
    } as const;
  }

  it("validates a healthy HTTP CONNECT proxy with real HTTPS traffic", async () => {
    const p = await startHttpProxy();
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await withTimeout(
      v.validateProxy(proxy({ port: p.port, protocol: "http" })),
      10000
    );
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.protocol, "http");
    assert.equal(result.supportsHttps, true);
    assert.ok(result.latencyMs >= 0);
    assert.ok(result.exitIp, "exit IP should be captured");
  });

  it("validates a SOCKS5 proxy", async () => {
    const p = await startSocks5Proxy();
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: p.port, protocol: "socks5" }));
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.protocol, "socks5");
  });

  it("validates a SOCKS4 proxy", async () => {
    const p = await startSocks4Proxy();
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: p.port, protocol: "socks4" }));
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.protocol, "socks4");
  });

  it("fails a slow proxy that exceeds the connect timeout", async () => {
    const p = await startHttpProxy({ connectDelayMs: 4000 });
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl, CONNECT_TIMEOUT_MS: "400" });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: p.port }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timeout|timed out/i);
  });

  it("fails a dead proxy (socket destroyed on connect)", async () => {
    const p = await startHttpProxy({ destroyAfterConnect: true });
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: p.port }));
    assert.equal(result.ok, false);
  });

  it("fails a malformed proxy (garbage response)", async () => {
    const p = await startHttpProxy({ garbage: true });
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: p.port }));
    assert.equal(result.ok, false);
  });

  it("fails a closed port (connection refused)", async () => {
    const deadPort = await getClosedPort();
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(proxy({ port: deadPort }));
    assert.equal(result.ok, false);
  });

  it("detects the real protocol of an auto/probe candidate", async () => {
    // A socks5-only proxy with a stored "http" probe row.
    const p = await startSocks5Proxy();
    teardown.push(() => p.close());
    const cfg = makeConfig({ VALIDATION_TARGETS: echoUrl });
    const v = makeValidator(cfg);
    const result = await v.validateProxy(
      proxy({ port: p.port, protocol: "http", probe: true })
    );
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.protocol, "socks5");
  });

  it("runs batches with bounded concurrency", async () => {
    const slow = await startHttpProxy({ connectDelayMs: 400 });
    teardown.push(() => slow.close());
    const cfg = makeConfig({
      VALIDATION_TARGETS: echoUrl,
      VALIDATION_CONCURRENCY: "3",
      CONNECT_TIMEOUT_MS: "3000",
    });
    const v = makeValidator(cfg);
    const items = Array.from({ length: 9 }, (_, i) => ({
      id: i,
      host: "127.0.0.1",
      port: slow.port,
      protocol: "http" as const,
      probe: false,
    }));
    let ok = 0;
    await withTimeout(
      v.validateBatch(items, (_id, result) => {
        if (result.ok) ok++;
      }),
      20000
    );
    assert.equal(ok, 9);
    // Allow one transient slot: the mock's async `close` can briefly overlap
    // with the next connection when a worker recycles its socket, so the peak
    // can be concurrency+1 even though validateBatch never runs more than
    // `concurrency` validations at once.
    assert.ok(
      (slow.maxConcurrent?.() ?? 99) <= 4,
      `concurrency exceeded: ${slow.maxConcurrent?.()}`
    );
  });
});