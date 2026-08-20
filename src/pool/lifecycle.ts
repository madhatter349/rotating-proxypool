import type { ProxyRecord, ProxyStatus } from "../types.js";
import type { Env } from "../config.js";
import { computeScore } from "./scoring.js";

export interface LifecycleDecision {
  status: ProxyStatus;
  quarantinedUntil: Date | null;
  score: number;
}

/**
 * Decide the next lifecycle state after a successful validation / gateway use.
 */
export function decideAfterSuccess(proxy: ProxyRecord): LifecycleDecision {
  const score = computeScore(proxy);
  const wasQuarantined = proxy.status === "quarantined";
  return {
    status: "healthy",
    quarantinedUntil: wasQuarantined ? null : proxy.quarantined_until,
    score,
  };
}

/**
 * Decide the next lifecycle state after a failure.
 * Healthy -> degraded (few failures), degraded/quarantined after threshold.
 */
export function decideAfterFailure(
  proxy: ProxyRecord,
  env: Env
): LifecycleDecision {
  const score = computeScore(proxy);
  const consecutive = proxy.consecutive_failures;

  if (consecutive >= env.CONSECUTIVE_FAILURES_TO_QUARANTINE) {
    return {
      status: "quarantined",
      quarantinedUntil: new Date(Date.now() + env.QUARANTINE_MS),
      score,
    };
  }

  if (proxy.status === "healthy" || proxy.status === "degraded") {
    return { status: "degraded", quarantinedUntil: null, score };
  }
  return { status: proxy.status, quarantinedUntil: null, score };
}