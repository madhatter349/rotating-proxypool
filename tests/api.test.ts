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

  it("protects /api/* routes but not /api-meta or /api/validate-target", async () => {
    app = await build();
    const denied = await app.inject({ method: "GET", url: "/api/proxies" });
    assert.equal(denied.statusCode, 401);
    const meta = await app.inject({ method: "GET", url: "/api-meta" });
    assert.equal(meta.statusCode, 200);
    const vt = await app.inject({ method: "GET", url: "/api/validate-target" });
    assert.equal(vt.statusCode, 200);
  });

  it("serves a J.Crew-shaped validation target with the body marker", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/api/validate-target" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    const body = res.json();
    assert.equal(body._type, "product_result");
    assert.equal(body.count, 2);
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data[0].brand, "J.Crew");
    assert.equal(body.data[0].ean, "99108055280");
    assert.ok(body.data[0].source_ip);
    // The marker must be present so the validator can require it.
    assert.equal(body.proxy_pool_validate_marker, "rotating-proxypool-validate");
    assert.match(res.body, /rotating-proxypool-validate/);
  });
});
