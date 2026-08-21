/**
 * Pure, deterministic selection-quality math for the gateway.
 *
 * The persisted `score` mixes validation and gateway history; this module adds a
 * distinct PRODUCTION-evidence factor (real gateway success, decayed over time),
 * a latency estimate from recent real traffic, a recent-failure penalty, and an
 * optional source-quality multiplier — so a proxy that merely passed validation
 * long ago stops competing with one recently proven by live traffic.
 */

export interface GatewayEvidence {
  /** Total real gateway successes observed. */
  successCount: number;
  /** Epoch ms of the last real gateway success (null if none). */
  lastSuccessAt: number | null;
  /** Real gateway failures within the recent window. */
  recentFailures: number;
  /** Bounded span of recent real-gateway latencies (ms). */
  recentLatenciesMs: number[];
}

export interface SourceStats {
  attempts: number;
  successes: number;
}

export interface SelectionParams {
  hotWindowMs: number;
  decayMs: number;
  /** Fraction of remaining weight removed per recent gateway failure. */
  failurePenalty: number;
  /** Minimum per-source gateway attempts before its success rate may matter. */
  confidenceMin: number;
  /** Latency (ms) assumed when no measurement exists. */
  medianLatencyFallbackMs: number;
}

export const EMPTY_EVIDENCE: GatewayEvidence = {
  successCount: 0,
  lastSuccessAt: null,
  recentFailures: 0,
  recentLatenciesMs: [],
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Median of a numeric array, else null. */
export function medianOf(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Production-freshness component (0..1). 1 while a gateway success is fresh
 * (within hotWindowMs), decaying linearly to a floor as the evidence ages past
 * the decay horizon. No gateway evidence at all yields the exploration floor so
 * freshly-validated (but unproven) proxies are still triable.
 */
export function freshnessFactor(ev: GatewayEvidence, p: SelectionParams, now: number): number {
  if (ev.lastSuccessAt == null || ev.successCount === 0) return 0.5;
  const age = now - ev.lastSuccessAt;
  if (age < 0) return 1;
  if (age <= p.hotWindowMs) return 1;
  if (age >= p.decayMs) return 0.35;
  // linear decay from 1 -> 0.35 between hotWindow and decay.
  return 1 - 0.65 * ((age - p.hotWindowMs) / (p.decayMs - p.hotWindowMs));
}

/** Recent-gateway-failure penalty (0..1): multiplier applied to weight. */
export function failureFactor(ev: GatewayEvidence, p: SelectionParams): number {
  const steps = Math.min(ev.recentFailures, 3);
  return clamp(1 - steps * p.failurePenalty, 0.25, 1);
}

/** Mild boost once a proxy is repeatedly proven by real traffic (capped to avoid a few proxies monopolizing). */
export function historyFactor(ev: GatewayEvidence): number {
  return clamp(0.5 + 0.02 * Math.min(ev.successCount, 25), 0.5, 1);
}

/**
 * Combined production-quality multiplier for exploit selections (0..1).
 * No evidence -> exploration base (0.5). A freshly proven, low-failure proxy
 * approaches ~1 but never exceeds it, so a handful of fast proxies cannot
 * monopolize the pool.
 */
export function qualityMultiplier(
  ev: GatewayEvidence,
  p: SelectionParams,
  now: number
): number {
  const fresh = freshnessFactor(ev, p, now);
  const fail = failureFactor(ev, p);
  const hist = historyFactor(ev);
  return clamp(fresh * fail * hist, 0.25, 1);
}

/**
 * Source-quality multiplier (0.8..1). Plain 1 until the source has enough real
 * gateway attempts; only then de-weights a consistently-failing source. The
 * impact is bounded so a source is never entirely suppressed from a small or
 * stale sample.
 */
export function sourceMultiplier(
  sourceStats: SourceStats | undefined,
  p: SelectionParams
): number {
  if (!sourceStats || sourceStats.attempts < p.confidenceMin) return 1;
  const rate = sourceStats.successes / sourceStats.attempts;
  if (rate >= 0.6) return 1;
  return clamp(0.75 + 0.25 * (rate / 0.6), 0.75, 1);
}

/** Latency estimate (ms) to use for a proxy from recent real gateway traffic. */
export function selectionLatencyMs(
  ev: GatewayEvidence,
  fallbackLatencyMs: number | null | undefined,
  p: SelectionParams
): number {
  const med = medianOf(ev.recentLatenciesMs);
  if (med != null && med > 0) return med;
  return fallbackLatencyMs && fallbackLatencyMs > 0
    ? fallbackLatencyMs
    : p.medianLatencyFallbackMs;
}

/** Exploitation weight: favors fresh, proven, fast, reliable proxies. */
export function exploitWeight(
  proxyScore: number,
  ev: GatewayEvidence,
  sourceStats: SourceStats | undefined,
  latencyMs: number | null | undefined,
  latencyFactor: (latencyMs: number) => number,
  p: SelectionParams,
  now: number
): number {
  const scoreNorm = clamp(proxyScore / 100, 0.2, 1);
  const q = qualityMultiplier(ev, p, now);
  const src = sourceMultiplier(sourceStats, p);
  const lat = latencyFactor(selectionLatencyMs(ev, latencyMs, p));
  return Math.max(0.001, scoreNorm * q * src * lat);
}

/** Exploration weight: samples the wider validated pool, ignoring production evidence but still latency-aware. */
export function exploreWeight(
  proxyScore: number,
  latencyMs: number | null | undefined,
  latencyFactor: (latencyMs: number) => number,
  p: SelectionParams
): number {
  const scoreNorm = clamp(proxyScore / 100, 0.2, 1);
  const lat = latencyFactor(latencyMs ?? p.medianLatencyFallbackMs);
  return Math.max(0.001, scoreNorm * lat);
}