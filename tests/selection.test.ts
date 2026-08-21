import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Validator } from "../src/validate/validator.js";
import { PoolManager } from "../src/pool/manager.js";
import { createRotationContext, selectWeighted } from "../src/pool/rotator.js";
import { latencyWeight } from "../src/pool/rotator.js";
import {
  EMPTY_EVIDENCE,
  type GatewayEvidence,
  type SelectionParams,
  qualityMultiplier,
  freshnessFactor,
  failureFactor,
  historyFactor,
  successLatencyFactor,
  sourceMultiplier,
  selectionLatencyMs,
  exploitWeight,
  exploreWeight,
  medianOf,
} from "../src/pool/selection.js";
import { FakeRepository, healthyRecord } from "./helpers/fakeRepo.js";
import { makeConfig } from "./helpers/testEnv.js";

const PARAMS: SelectionParams = {
  hotWindowMs: 900_000, // 15m
  decayMs: 1_800_000, // 30m
  failurePenalty: 0.5,
  confidenceMin: 8,
  medianLatencyFallbackMs: 3000,
  slowLatencyThresholdMs: 3000,
  verySlowLatencyThresholdMs: 6000,
};
const NOW = 1_000_000_000_000;

function ev(over: Partial<GatewayEvidence> = {}): GatewayEvidence {
  return {
    ...EMPTY_EVIDENCE,
    recentLatenciesMs: [...EMPTY_EVIDENCE.recentLatenciesMs],
    ...over,
  };
}

/** Deterministic seed helper (same approach as gateway.test). */
function seedRandom(seq: number[]): () => void {
  const real = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)] ?? 0;
  return () => {
    Math.random = real;
  };
}

describe("selection unit", () => {
  it("a freshly proven fast proxy outweighs a stale slow proxy", () => {
    const fresh = ev({ successCount: 5, lastSuccessAt: NOW - 1000, recentLatenciesMs: [120] });
    const stale = ev({ successCount: 2, lastSuccessAt: NOW - 200_000_000, recentLatenciesMs: [5000] });
    const wFresh = exploitWeight(90, fresh, undefined, 150, latencyWeight, PARAMS, NOW);
    const wStale = exploitWeight(90, stale, undefined, 5200, latencyWeight, PARAMS, NOW);
    assert.ok(wFresh > wStale * 1.5, `fresh=${wFresh} stale=${wStale}`);
  });

  it("no gateway evidence still leaves a validated proxy selectable (exploration base)", () => {
    const q = qualityMultiplier(EMPTY_EVIDENCE, PARAMS, NOW);
    assert.ok(q > 0, "unproven proxy is triable, not zeroed");
    const w = exploreWeight(75, 800, latencyWeight, PARAMS);
    assert.ok(w > 0.05);
  });

  it("recent real failure de-weights a proxy immediately", () => {
    const freshGood = ev({ successCount: 5, lastSuccessAt: NOW - 1000, recentFailures: 0 });
    const freshBad = ev({ successCount: 5, lastSuccessAt: NOW - 1000, recentFailures: 2 });
    const qGood = qualityMultiplier(freshGood, PARAMS, NOW);
    const qBad = qualityMultiplier(freshBad, PARAMS, NOW);
    assert.ok(qGood > qBad);
    // 1 - 2*0.5 = 0 -> clamped to the 0.25 floor
    assert.equal(failureFactor(freshBad, PARAMS), 0.25);
  });

  it("a recent slow success is de-weighted relative to a recent fast success", () => {
    const fast = ev({ successCount: 5, lastSuccessAt: NOW - 1000, recentLatenciesMs: [800, 900, 700] });
    const slow = ev({ successCount: 5, lastSuccessAt: NOW - 1000, recentLatenciesMs: [800, 900, 4500] });
    assert.equal(successLatencyFactor(fast, PARAMS), 1);
    assert.equal(successLatencyFactor(slow, PARAMS), 0.65);
    assert.ok(qualityMultiplier(fast, PARAMS, NOW) > qualityMultiplier(slow, PARAMS, NOW));
  });

  it("a very slow success de-weights immediately (not smoothed away by the median)", () => {
    // The most recent success is extremely slow even though the median was fast.
    const slow = ev({ successCount: 10, lastSuccessAt: NOW - 1000, recentLatenciesMs: [700, 800, 600, 11000] });
    assert.equal(Math.round(medianOf(slow.recentLatenciesMs) ?? 0), 750, "median is fast");
    assert.equal(successLatencyFactor(slow, PARAMS), 0.3, "least-recent latency governs quality");
  });

  it("a proxy that just succeeded very slowly is selected less often than one that succeeded fast", async () => {
    const repo = new FakeRepository();
    await repo.insert(healthyRecord(21, "127.0.0.1", 3001, "http"));
    await repo.insert(healthyRecord(22, "127.0.0.1", 3002, "http"));
    const cfg = makeConfig({
      GATEWAY_EXPLORATION_FRACTION: "0",
      SLOW_SUCCESS_THRESHOLD_MS: "3000",
      VERY_SLOW_SUCCESS_THRESHOLD_MS: "6000",
      SLOW_SUCCESS_COOLDOWN_MS: "0",
    });
    const pool = new PoolManager(repo, new Validator(cfg), cfg);
    await pool.init();
    // same score; one succeeded fast, the other very slowly
    await pool.onGatewaySuccess(21, 900);
    await pool.onGatewaySuccess(22, 11000);
    const counts = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      const p = pool.selectUpstream(undefined, NOW + i);
      if (p) counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    assert.ok((counts.get(21) ?? 0) > (counts.get(22) ?? 0), `counts=${[...counts]}`);
  });

  it("a very slow success emits a short selection cooldown", async () => {
    const repo = new FakeRepository();
    await repo.insert(healthyRecord(31, "127.0.0.1", 4001, "http"));
    await repo.insert(healthyRecord(32, "127.0.0.1", 4002, "http"));
    const cfg = makeConfig({
      VERY_SLOW_SUCCESS_THRESHOLD_MS: "6000",
      SLOW_SUCCESS_COOLDOWN_MS: "30000",
    });
    const pool = new PoolManager(repo, new Validator(cfg), cfg);
    await pool.init();
    const t = Date.now();
    await pool.onGatewaySuccess(31, 12000); // very slow success
    // 31 now on a short cooldown, so it is excluded from immediate reselection.
    assert.ok(pool.getCooldownMs(31) > t, "cooldown should be armed after very slow success");
    // fast success on 32 leaves it free of cooldown.
    await pool.onGatewaySuccess(32, 900);
    assert.equal(pool.getCooldownMs(32), 0);
  });

  it("stale production success decays over time", () => {
    // fresh within hot window
    assert.equal(freshnessFactor(ev({ successCount: 1, lastSuccessAt: NOW - 1000 }), PARAMS, NOW), 1);
    // fully decayed
    assert.equal(freshnessFactor(ev({ successCount: 1, lastSuccessAt: NOW - 10_000_000 }), PARAMS, NOW), 0.35);
    // partially decayed (between hotWindow and decay): monotone decreasing
    const mid = freshnessFactor(ev({ successCount: 1, lastSuccessAt: NOW - PARAMS.hotWindowMs - 1000 }), PARAMS, NOW);
    assert.ok(mid > 0.35 && mid < 1);
  });

  it("slow proxy is de-weighted relative to an equally reliable fast one", () => {
    const same = ev({ successCount: 10, lastSuccessAt: NOW - 1000 });
    const fast = exploitWeight(90, same, undefined, 120, latencyWeight, PARAMS, NOW);
    const slow = exploitWeight(90, same, undefined, 8000, latencyWeight, PARAMS, NOW);
    assert.ok(fast > slow);
  });

  it("history confidence is capped so a few proxies cannot monopolize", () => {
    const tiny = historyFactor(ev({ successCount: 1 }));
    const huge = historyFactor(ev({ successCount: 10_000 }));
    // capped, bounded well above nothing
    assert.ok(huge <= 1);
    assert.ok(tiny === 0.52);
    assert.ok(huge / tiny < 2, "history must not produce runaway dominance");
  });

  it("quality multiplier never exceeds 1", () => {
    const best = ev({ successCount: 100, lastSuccessAt: NOW, recentFailures: 0 });
    assert.equal(qualityMultiplier(best, PARAMS, NOW), 1);
  });

  it("source quality stays neutral until enough gateway attempts", () => {
    assert.equal(sourceMultiplier({ attempts: 3, successes: 0 }, PARAMS), 1);
    assert.equal(sourceMultiplier({ attempts: 8, successes: 8 }, PARAMS), 1);
    const failingSource = sourceMultiplier({ attempts: 8, successes: 1 }, PARAMS);
    assert.ok(failingSource < 1 && failingSource >= 0.75, `source mult ${failingSource}`);
  });

  it("selection latency prefers recent real-traffic median over stale single sample", () => {
    const e = ev({ recentLatenciesMs: [900, 1000, 1100] });
    assert.equal(selectionLatencyMs(e, 6500, PARAMS), 1000);
    assert.equal(medianOf([900, 1000, 1100]), 1000);
  });
});

describe("selection integration (manager)", () => {
  it("selectively prefers a freshly proven proxy over a stale one (exploit, seeded)", async () => {
    const repo = new FakeRepository();
    // proxy 1 freshly proven & fast
    await repo.insert(healthyRecord(1, "127.0.0.1", 1001, "http"));
    // proxy 2 stale, no gateway evidence
    await repo.insert({
      ...healthyRecord(2, "127.0.0.1", 1002, "http"),
      last_success: new Date(NOW - 200_000_000),
      latency_ms: 6000,
      score: 80,
    });
    const cfg = makeConfig({ GATEWAY_EXPLORATION_FRACTION: "0" });
    const pool = new PoolManager(repo, new Validator(cfg), cfg);
    await pool.init();
    // give proxy 1 fresh real evidence
    await pool.onGatewaySuccess(1, 120);
    await pool.onGatewaySuccess(1, 130);

    const counts = new Map<number, number>();
    for (let i = 0; i < 50; i++) {
      const p = pool.selectUpstream(undefined, NOW + i);
      counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    // Fresh, proven, fast proxy is preferred.
    assert.ok((counts.get(1) ?? 0) > (counts.get(2) ?? 0), `counts=${[...counts]}`);
    // ...but the stale one is still tried sometimes (no collapse).
    assert.ok((counts.get(2) ?? 0) > 0, `diversity required: ${[...counts]}`);
  });

  it("exploration selects the wider pool even without production evidence", async () => {
    const repo = new FakeRepository();
    await repo.insert(healthyRecord(11, "127.0.0.1", 2001, "http"));
    await repo.insert(healthyRecord(12, "127.0.0.1", 2002, "http"));
    const cfg = makeConfig({ GATEWAY_EXPLORATION_FRACTION: "1.0" });
    const pool = new PoolManager(repo, new Validator(cfg), cfg);
    await pool.init();
    const counts = new Map<number, number>();
    for (let i = 0; i < 200; i++) {
      const p = pool.selectUpstream(undefined, NOW + i);
      counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    assert.equal(counts.size, 2, "exploration must reach both proxies");
    const sel = pool.getSelectionStats(NOW + 300);
    assert.ok(sel.exploreSelections >= 190, `selections ${JSON.stringify(sel)}`);
  });

  it("selectWeighted honors weightOf and preserves diversity via recency", () => {
    const pool = [healthyRecord(1, "127.0.0.1", 1, "http"), healthyRecord(2, "127.0.0.1", 2, "http")];
    const ctx = createRotationContext();
    // weightOf strongly prefers proxy 1, but recency forces spread.
    const restore = seedRandom([0.02, 0.02, 0.02, 0.99]);
    try {
      const picks: number[] = [];
      for (let i = 0; i < 4; i++) {
        const p = selectWeighted(pool, ctx, { now: i * 1000, weightOf: (q) => (q.id === 1 ? 100 : 1) });
        picks.push(p!.id);
      }
      assert.ok(picks.includes(2), `diversity preserved by recency: ${picks}`);
    } finally {
      restore();
    }
  });
});