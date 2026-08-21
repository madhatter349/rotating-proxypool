import type { ProxyRecord } from "../types.js";

export interface RotationContext {
  /** Tracks the last time each proxy id was selected (ms epoch). */
  lastSelected: Map<number, number>;
  /** Tracks selection counts to smooth distribution. */
  selectionCount: Map<number, number>;
}

export function createRotationContext(): RotationContext {
  return { lastSelected: new Map(), selectionCount: new Map() };
}

/** Options mirroring per-call behavior. */
export interface SelectWeightedOptions {
  now?: number;
  decaySeconds?: number;
  excludeIds?: Set<number>;
}

/**
 * Weighted random selection from a healthy pool.
 *
 * Base weight = proxy score (which already folds in success rate, latency,
 * freshness, and stability). A recency penalty spreads traffic across the
 * pool, and a latency factor de-weights slow upstreams while preserving
 * diversity so rotation does not collapse to a single fast exit.
 */
export function selectWeighted(
  proxies: ProxyRecord[],
  ctx: RotationContext,
  opts: SelectWeightedOptions = {}
): ProxyRecord | null {
  const now = opts.now ?? Date.now();
  const decaySeconds = opts.decaySeconds ?? 30;
  const candidates = proxies.filter((p) => !opts.excludeIds?.has(p.id));
  if (candidates.length === 0) return null;

  const weighted: Array<{ proxy: ProxyRecord; weight: number }> = [];
  let totalWeight = 0;

  for (const proxy of candidates) {
    const lastUsed = ctx.lastSelected.get(proxy.id);
    let recencyFactor = 1;
    if (lastUsed != null) {
      const ageSec = (now - lastUsed) / 1000;
      recencyFactor = 0.4 + 0.6 * Math.exp(-ageSec / decaySeconds);
    }
    const selectionBias = Math.max(0.3, 1 - 0.05 * (ctx.selectionCount.get(proxy.id) ?? 0));
    const latencyFactor = latencyWeight(proxy.latency_ms);
    const weight = Math.max(1, proxy.score) * recencyFactor * selectionBias * latencyFactor;
    weighted.push({ proxy, weight });
    totalWeight += weight;
  }

  let roll = Math.random() * totalWeight;
  for (const { proxy, weight } of weighted) {
    roll -= weight;
    if (roll <= 0) {
      ctx.lastSelected.set(proxy.id, now);
      ctx.selectionCount.set(proxy.id, (ctx.selectionCount.get(proxy.id) ?? 0) + 1);
      return proxy;
    }
  }
  const fallback = weighted[weighted.length - 1]?.proxy ?? null;
  if (fallback) {
    ctx.lastSelected.set(fallback.id, now);
    ctx.selectionCount.set(fallback.id, (ctx.selectionCount.get(fallback.id) ?? 0) + 1);
  }
  return fallback;
}

/**
 * Latency-aware de-weighting (1 = fast, decays toward 0.55 for very slow
 * proxies). Kept mild so the pool stays diverse: a slow-but-working proxy is
 * still selectable, just less often than a fast one.
 */
export function latencyWeight(latencyMs: number | null | undefined): number {
  const lat = latencyMs ?? 3000;
  if (lat <= 500) return 1;
  if (lat <= 1000) return 0.92;
  if (lat <= 2000) return 0.82;
  if (lat <= 5000) return 0.68;
  return 0.55;
}