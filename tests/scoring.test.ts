import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeScore, isHealthy, isUsableForGateway } from "../src/pool/scoring.js";

describe("scoring unit", () => {
  const base = {
    success_count: 10,
    failure_count: 0,
    consecutive_failures: 0,
    latency_ms: 100,
    last_success: new Date(),
  };

  it("scores a fresh, reliable, fast proxy highly", () => {
    assert.ok(computeScore(base) >= 85);
  });

  it("high latency reduces score", () => {
    const slow = { ...base, latency_ms: 8000 };
    assert.ok(computeScore(slow) < computeScore(base));
  });

  it("recent success increases score over stale", () => {
    const stale = { ...base, last_success: new Date(Date.now() - 7 * 86400_000) };
    assert.ok(computeScore(stale) < computeScore(base));
  });

  it("consecutive failures reduce score", () => {
    const failing = { ...base, consecutive_failures: 5 };
    assert.ok(computeScore(failing) < computeScore(base));
  });

  it("low success rate reduces score", () => {
    const lowRate = {
      ...base,
      success_count: 1,
      failure_count: 9,
      consecutive_failures: 3,
    };
    assert.ok(computeScore(lowRate) < computeScore(base));
  });

  it("score is bounded 0-100", () => {
    assert.equal(computeScore({ ...base, latency_ms: 1, success_count: 1000, failure_count: 0 }), 100);
    const worst = computeScore({
      ...base,
      success_count: 0,
      failure_count: 100,
      consecutive_failures: 100,
      latency_ms: 60000,
      last_success: null,
    });
    assert.ok(worst <= 10, `worst-case score should be near zero, got ${worst}`);
  });

  it("no history defaults to a neutral score", () => {
    const s = computeScore({
      success_count: 0,
      failure_count: 0,
      consecutive_failures: 0,
      latency_ms: null,
      last_success: null,
    });
    assert.ok(s > 0 && s < 60);
  });

  it("isHealthy respects score threshold and status", () => {
    assert.equal(isHealthy({ status: "healthy", score: 50, minHealthyScore: 25 }), true);
    assert.equal(isHealthy({ status: "healthy", score: 10, minHealthyScore: 25 }), false);
    assert.equal(isHealthy({ status: "degraded", score: 90, minHealthyScore: 25 }), false);
  });

  it("isUsableForGateway excludes quarantined/dead/low-score", () => {
    const fresh = new Date();
    const mk = (over: Record<string, unknown>) => ({
      status: "healthy",
      quarantined_until: null,
      score: 80,
      minHealthyScore: 25,
      last_success: fresh,
      last_checked: fresh,
      latency_ms: 200,
      ...over,
    });
    assert.equal(isUsableForGateway(mk({})), true);
    assert.equal(isUsableForGateway(mk({ status: "quarantined" })), false);
    assert.equal(isUsableForGateway(mk({ status: "dead" })), false);
    assert.equal(isUsableForGateway(mk({ score: 10 })), false);
  });

  it("isUsableForGateway excludes proxies whose last success is stale", () => {
    const mk = (over: Record<string, unknown>) => ({
      status: "healthy",
      quarantined_until: null,
      score: 80,
      minHealthyScore: 25,
      last_success: new Date(),
      last_checked: new Date(),
      latency_ms: 200,
      maxLastSuccessAgeMs: 900_000,
      ...over,
    });
    // Fresh -> usable.
    assert.equal(isUsableForGateway(mk({})), true);
    // Stale last_success -> excluded.
    assert.equal(
      isUsableForGateway(
        mk({ last_success: new Date(Date.now() - 2 * 60 * 60_000) })
      ),
      false
    );
    // Never checked -> excluded.
    assert.equal(isUsableForGateway(mk({ last_success: null, last_checked: null })), false);
  });

  it("isUsableForGateway excludes proxies slower than the max latency", () => {
    const mk = (over: Record<string, unknown>) => ({
      status: "healthy",
      quarantined_until: null,
      score: 80,
      minHealthyScore: 25,
      last_success: new Date(),
      last_checked: new Date(),
      latency_ms: 200,
      maxLatencyMs: 5000,
      ...over,
    });
    assert.equal(isUsableForGateway(mk({})), true);
    assert.equal(isUsableForGateway(mk({ latency_ms: 6000 })), false);
    // Unknown latency is allowed through (no data to judge).
    assert.equal(isUsableForGateway(mk({ latency_ms: null })), true);
  });
});