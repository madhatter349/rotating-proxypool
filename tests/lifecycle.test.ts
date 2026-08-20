import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideAfterSuccess, decideAfterFailure } from "../src/pool/lifecycle.js";
import { makeConfig } from "./helpers/testEnv.js";

describe("lifecycle unit", () => {
  const cfg = makeConfig();

  function proxy(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      host: "1.2.3.4",
      port: 8080,
      protocol: "http",
      source: "test",
      first_seen: new Date(),
      last_seen: new Date(),
      last_checked: new Date(),
      last_success: new Date(),
      success_count: 10,
      failure_count: 0,
      consecutive_failures: 0,
      latency_ms: 100,
      success_rate: 1,
      exit_ip: null,
      country: null,
      supports_https: true,
      score: 90,
      status: "healthy",
      quarantined_until: null,
      last_error: null,
      probe: false,
      ...over,
    } as const;
  }

  it("success promotes quarantined -> healthy and clears quarantine", () => {
    const p = proxy({
      status: "quarantined",
      quarantined_until: new Date(Date.now() + 1000),
    });
    const d = decideAfterSuccess(p);
    assert.equal(d.status, "healthy");
    assert.equal(d.quarantinedUntil, null);
  });

  it("success keeps healthy proxies healthy", () => {
    const d = decideAfterSuccess(proxy());
    assert.equal(d.status, "healthy");
  });

  it("first failure degrades a healthy proxy", () => {
    const p = proxy({ consecutive_failures: 0 });
    const d = decideAfterFailure(p, cfg.env);
    assert.equal(d.status, "degraded");
    assert.equal(d.quarantinedUntil, null);
  });

  it("reaching the threshold quarantines with an expiry", () => {
    // The failure has already been recorded on the record (repos increment
    // consecutive_failures before decideAfterFailure is called).
    const p = proxy({
      consecutive_failures: cfg.env.CONSECUTIVE_FAILURES_TO_QUARANTINE,
    });
    const d = decideAfterFailure(p, cfg.env);
    assert.equal(d.status, "quarantined");
    assert.ok(d.quarantinedUntil && d.quarantinedUntil.getTime() > Date.now());
  });

  it("repeated failures keep quarantine pushed out", () => {
    const p = proxy({
      status: "quarantined",
      consecutive_failures: cfg.env.CONSECUTIVE_FAILURES_TO_QUARANTINE + 2,
    });
    const d = decideAfterFailure(p, cfg.env);
    assert.equal(d.status, "quarantined");
    assert.ok(d.quarantinedUntil && d.quarantinedUntil.getTime() > Date.now());
  });
});