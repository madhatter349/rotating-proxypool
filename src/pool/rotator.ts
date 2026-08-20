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

/**
 * Weighted random selection from a healthy pool.
 *
 * Base weight = proxy score. A recency penalty reduces the weight of proxies
 * selected recently so traffic spreads across the pool while still favoring
 * reliable, low-latency proxies.
 */
export function selectWeighted(
  proxies: ProxyRecord[],
  ctx: RotationContext,
  opts: { now?: number; decaySeconds?: number; excludeIds?: Set<number> } = {}
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
    const weight = Math.max(1, proxy.score) * recencyFactor * selectionBias;
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