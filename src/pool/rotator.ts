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
  /**
   * Optional enrichment: the base selection weight for a proxy. When present it
   * replaces the default score*latency base (recency + selection-bias diversity
   * are still applied on top). Returns a value > 0.
   */
  weightOf?: (proxy: ProxyRecord) => number;
}

/**
 * Weighted random selection from a healthy pool.
 *
 * Default base weight = proxy score (which already folds in success rate,
 * latency, freshness, and stability). When `weightOf` is supplied it provides the
 * base weight (e.g. enriched with production evidence from the manager). Either
 * way a recency penalty spreads traffic across the pool and a selection-bias
 * smooths distribution so a small number of proxies cannot monopolize.
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
    const base = opts.weightOf
      ? opts.weightOf(proxy)
      : Math.max(1, proxy.score) * latencyWeight(proxy.latency_ms);
    const weight = base * recencyFactor * selectionBias;
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
 * Latency-aware weighting: steeper than before so fast proxies dominate while
 * slow-but-working ones are heavily de-weighted. A proxy is not zeroed (so the
 * pool still rotates), but a 2s proxy is ~5x less likely than a 200ms one and a
 * 5s proxy is barely selected.
 */
export function latencyWeight(latencyMs: number | null | undefined): number {
  const lat = latencyMs ?? 3000;
  if (lat <= 250) return 1;
  if (lat <= 500) return 0.9;
  if (lat <= 1000) return 0.7;
  if (lat <= 2000) return 0.5;
  if (lat <= 3000) return 0.35;
  if (lat <= 5000) return 0.2;
  return 0.1;
}