import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRotationContext,
  selectWeighted,
} from "../src/pool/rotator.js";
import type { ProxyRecord } from "../src/types.js";

function mk(id: number, score: number): ProxyRecord {
  return {
    id,
    host: `h${id}`,
    port: 80,
    protocol: "http",
    source: "test",
    first_seen: new Date(),
    last_seen: new Date(),
    last_checked: new Date(),
    last_success: new Date(),
    success_count: 1,
    failure_count: 0,
    consecutive_failures: 0,
    latency_ms: 50,
    success_rate: 1,
    exit_ip: null,
    country: null,
    supports_https: true,
    score,
    status: "healthy",
    quarantined_until: null,
    last_error: null,
    probe: false,
  };
}

/** Same as mk but with an explicit latency override. */
function mkLat(id: number, score: number, latency_ms: number): ProxyRecord {
  return { ...mk(id, score), latency_ms };
}

describe("rotator unit", () => {
  it("returns null for empty pool", () => {
    assert.equal(selectWeighted([], createRotationContext()), null);
  });

  it("returns the only proxy", () => {
    const p = selectWeighted([mk(1, 90)], createRotationContext());
    assert.equal(p?.id, 1);
  });

  it("never returns excluded proxies", () => {
    const pool = [mk(1, 90), mk(2, 80)];
    for (let i = 0; i < 50; i++) {
      const p = selectWeighted(pool, createRotationContext(), {
        excludeIds: new Set([1]),
      });
      assert.equal(p?.id, 2);
    }
  });

  it("distributes selection across the pool", () => {
    const ctx = createRotationContext();
    const pool = [mk(1, 100), mk(2, 100), mk(3, 100)];
    const counts = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const p = selectWeighted(pool, ctx);
      counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    // All three should be used with roughly equal frequency.
    assert.equal(counts.size, 3);
    const [a, b, c] = [...counts.values()];
    const spread = Math.max(a!, b!, c!) - Math.min(a!, b!, c!);
    assert.ok(spread < 150, `selection too skewed: ${[...counts.values()]}`);
  });

  it("favors higher-scored proxies over time", () => {
    const ctx = createRotationContext();
    const pool = [mk(1, 100), mk(2, 1)];
    const counts = new Map<number, number>();
    for (let i = 0; i < 200; i++) {
      const p = selectWeighted(pool, ctx);
      counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    assert.ok((counts.get(1) ?? 0) > (counts.get(2) ?? 0));
  });

  it("favors lower-latency proxies when scores are equal", () => {
    const ctx = createRotationContext();
    const pool = [mkLat(1, 90, 50), mkLat(2, 90, 8000)];
    const counts = new Map<number, number>();
    for (let i = 0; i < 200; i++) {
      const p = selectWeighted(pool, ctx);
      counts.set(p!.id, (counts.get(p!.id) ?? 0) + 1);
    }
    // Fast proxy selected more often, but the slow one is still occasionally
    // used so diversity of exits is preserved.
    assert.ok((counts.get(1) ?? 0) > (counts.get(2) ?? 0), `got ${counts}`);
    assert.ok((counts.get(2) ?? 0) > 10, `slow proxy should still appear: ${counts}`);
  });

  it("tracks lastSelected in context", () => {
    const ctx = createRotationContext();
    const pool = [mk(1, 90), mk(2, 90)];
    selectWeighted(pool, ctx);
    assert.equal(ctx.lastSelected.size >= 1, true);
  });
});