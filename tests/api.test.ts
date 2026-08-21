import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../src/api/server.js";
import { FakeRepository } from "./helpers/fakeRepo.js";
import { makeConfig } from "./helpers/testEnv.js";

describe("api server", () => {
  let app: Awaited<ReturnType<typeof buildApi>>;
  const teardown: Array<() => Promise<void>> = [];

  async function build(cfgOverrides: Record<string, string> = {}) {
    const repo = new FakeRepository();
    const cfg = makeConfig(cfgOverrides);
    const gateway = {
      host: "proxy.example.com",
      port: 51121,
      stats: {
        connections: 0,
        connectRequests: 0,
        httpRequests: 0,
        authFailures: 0,
        upstreamFailures: 0,
        retries: 0,
        tunnelEstablished: 0,
        success: 0,
        earlyClose: 0,
        startedAt: new Date().toISOString(),
        totalClientRequests: 0,
        firstAttemptSuccess: 0,
        retryRecovered: 0,
        retryExhausted: 0,
        timeouts: 0,
        requestDurations: [],
        requestsByProtocol: {},
      },
    } as never;
    const pool = { getActivePool: () => [], getLastRefreshAt: () => null, getRecentFailures: () => [], getSelectionStats: () => ({ hotPoolSize: 0, exploreSelections: 0, exploitSelections: 0 }), getSourceStats: () => ({}) } as never;
    const sources = { getSources: async () => [], refreshAll: async () => [] } as never;
    const app = await buildApi({ repo: repo as never, pool, sources, gateway, cfg });
    await app.listen({ port: 0, host: "127.0.0.1" });
    teardown.push(() => app.close());
    return app;
  }

  after(async () => {
    for (const fn of teardown) await fn();
  });

  it("serves /health", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, "1.0.0");
  });

  it("serves /ready", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().db, true);
  });

  it("serves /api-meta with safe public metadata (no secrets)", async () => {
    app = await build({
      PUBLIC_PROXY_HOST: "proxy.example.com",
      PUBLIC_PROXY_PORT: "51121",
      PUBLIC_API_URL: "https://dashboard.example.com",
    });
    const res = await app.inject({ method: "GET", url: "/api-meta" });
    assert.equal(res.statusCode, 200);
    const meta = res.json();
    assert.equal(meta.gateway.host, "proxy.example.com");
    assert.equal(meta.gateway.port, 51121);
    assert.equal(meta.gateway.authRequired, true);
    assert.equal(meta.gateway.username, "testuser");
    assert.equal(meta.gateway.passwordConfigured, true);
    assert.equal(meta.admin.configured, true);
    // Never expose the password or the token.
    assert.ok(!JSON.stringify(meta).includes("testpass"));
    assert.ok(!JSON.stringify(meta).includes("test-admin-token"));
  });

  it("protects /api/* routes but not /api-meta or /api/validate", async () => {
    app = await build();
    const denied = await app.inject({ method: "GET", url: "/api/proxies" });
    assert.equal(denied.statusCode, 401);
    const meta = await app.inject({ method: "GET", url: "/api-meta" });
    assert.equal(meta.statusCode, 200);
    const vt = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(vt.statusCode, 200);
  });

  it("serves an open validation target that echoes the source IP and marker", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    const body = res.json();
    assert.equal(body.marker, "rotating-proxypool-validate");
    assert.equal(body.service, "rotating-proxypool");
    assert.ok(body.ip);
    assert.match(res.body, /rotating-proxypool-validate/);
  });

  it("rate-limits /api/validate per source IP (429 after the cap)", async () => {
    app = await build({ VALIDATE_RATE_LIMIT_PER_MIN: "3" });
    const first = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(second.statusCode, 200);
    const third = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(third.statusCode, 200);
    const blocked = await app.inject({ method: "GET", url: "/api/validate" });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
  });
});
