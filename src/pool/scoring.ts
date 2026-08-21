export interface ScoreInput {
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  latency_ms: number | null;
  last_success: Date | null;
}

/**
 * Compute a 0-100 health score for a proxy.
 *
 * Components:
 *  - success rate       (40%) historical reliability
 *  - latency            (25%) faster is better
 *  - freshness          (20%) how recently it last succeeded
 *  - stability          (15%) consecutive-failure penalty
 */
export function computeScore(proxy: ScoreInput, now: number = Date.now()): number {
  const total = proxy.success_count + proxy.failure_count;
  const successRate = total === 0 ? 0.5 : proxy.success_count / total;

  const lat = proxy.latency_ms ?? 3000;
  let latencyScore: number;
  if (lat <= 300) latencyScore = 1;
  else if (lat <= 1000) latencyScore = 0.8;
  else if (lat <= 3000) latencyScore = 0.5;
  else latencyScore = 0.2;

  const lastSuccessAge = proxy.last_success
    ? now - proxy.last_success.getTime()
    : Number.POSITIVE_INFINITY;
  let freshness: number;
  if (lastSuccessAge <= 5 * 60_000) freshness = 1;
  else if (lastSuccessAge <= 30 * 60_000) freshness = 0.8;
  else if (lastSuccessAge <= 2 * 3_600_000) freshness = 0.5;
  else if (lastSuccessAge <= 24 * 3_600_000) freshness = 0.3;
  else freshness = 0.1;

  const maxConsecutive = 5;
  const stability =
    1 - Math.min(proxy.consecutive_failures, maxConsecutive) / maxConsecutive;

  const raw =
    0.4 * successRate +
    0.25 * latencyScore +
    0.2 * freshness +
    0.15 * stability;

  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

export function isHealthy(proxy: {
  status: string;
  score: number;
  minHealthyScore: number;
}): boolean {
  return proxy.status === "healthy" && proxy.score >= proxy.minHealthyScore;
}

export function isUsableForGateway(proxy: {
  status: string;
  quarantined_until: Date | null;
  score: number;
  minHealthyScore: number;
  last_success: Date | null;
  last_checked: Date | null;
  /** Max age of last_success (ms) before a proxy is considered too stale to use. */
  maxLastSuccessAgeMs?: number;
}): boolean {
  if (proxy.status === "quarantined") return false;
  if (proxy.status === "dead") return false;
  if (proxy.score < proxy.minHealthyScore) return false;
  // A "healthy" proxy whose last real success is very old is almost certainly
  // dead: it passed validation long ago but nothing has confirmed it recently.
  // Excluding it keeps user traffic away from stale rows until a recheck proves
  // it alive again (which flips last_success back to now()).
  if (proxy.maxLastSuccessAgeMs != null) {
    const last = proxy.last_success ?? proxy.last_checked ?? null;
    if (last == null) return false;
    if (Date.now() - last.getTime() > proxy.maxLastSuccessAgeMs) return false;
  }
  return true;
}