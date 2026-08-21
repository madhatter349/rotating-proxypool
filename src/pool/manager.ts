import type { AppConfig } from "../config.js";
import type { ProxyCandidate, ProxyRecord, ProxyStatus, ValidationResult } from "../types.js";
import type { Validator } from "../validate/validator.js";
import { decideAfterFailure, decideAfterSuccess } from "./lifecycle.js";
import { createRotationContext, selectWeighted } from "./rotator.js";
import { latencyWeight } from "./rotator.js";
import { isUsableForGateway } from "./scoring.js";
import {
  EMPTY_EVIDENCE,
  type GatewayEvidence,
  type SelectionParams,
  type SourceStats,
  exploitWeight,
  exploreWeight,
} from "./selection.js";

/** The repository surface the pool manager depends on. */
export interface PoolRepo {
  getHealthyProxies(): Promise<ProxyRecord[]>;
  getProxy(id: number): Promise<ProxyRecord | null>;
  getPending(): Promise<ProxyRecord[]>;
  getProxiesByStatus(statuses: ProxyStatus[]): Promise<ProxyRecord[]>;
  getQuarantinedDue(): Promise<ProxyRecord[]>;
  markDead(olderThanMs: number): Promise<number>;
  applyValidationResult(id: number, result: ValidationResult): Promise<ProxyRecord | null>;
  recordSuccess(proxy: ProxyRecord): Promise<ProxyRecord>;
  recordFailure(proxy: ProxyRecord, error?: string | null): Promise<ProxyRecord>;
  setStatus(
    id: number,
    status: ProxyStatus,
    extras?: { quarantinedUntil?: Date | null; lastError?: string | null }
  ): Promise<ProxyRecord | null>;
  updateScore(id: number, score: number): Promise<void>;
  clearProbe(id: number): Promise<void>;
  upsertCandidate(candidate: ProxyCandidate): Promise<ProxyRecord>;
}

export interface RecentFailure {
  at: Date;
  host: string;
  port: number;
  protocol: string;
  error: string;
}

export class PoolManager {
  private healthy: ProxyRecord[] = [];
  private readonly rotationCtx = createRotationContext();
  private readonly recentFailures: RecentFailure[] = [];
  private lastRefreshAt: Date | null = null;
  private validationRunning = false;
  private checkRunning = false;
  /** proxyId -> epoch ms until which the proxy is excluded from rotation. */
  private readonly cooldownUntil = new Map<number, number>();
  /** In-memory production evidence per proxy (real gateway traffic). */
  private readonly gatewayEvidence = new Map<number, GatewayEvidence>();
  /** Real gateway attempt/success counts per source (source-quality evidence). */
  private readonly sourceStats = new Map<string, SourceStats>();
  /** Selection telemetry across this process. */
  private readonly exploitSelections = new Map<number, number>();
  private readonly exploreSelections = new Map<number, number>();
  readonly maxRecentFailures = 100;
  private static readonly MAX_EVIDENCE_LATENCIES = 10;
  private static readonly MAX_EVIDENCE_ENTRIES = 5000;

  /** For tests: read the cooldown window for a proxy. */
  getCooldownMs(proxyId: number): number {
    return this.cooldownUntil.get(proxyId) ?? 0;
  }

  /** For tests: inspect the production evidence for a proxy. */
  getGatewayEvidence(proxyId: number): GatewayEvidence {
    return this.gatewayEvidence.get(proxyId) ?? EMPTY_EVIDENCE;
  }

  constructor(
    private readonly repo: PoolRepo,
    private readonly validator: Validator,
    private readonly cfg: AppConfig
  ) {}

  async init(): Promise<void> {
    await this.refreshPool();
  }

  async refreshPool(): Promise<void> {
    this.healthy = await this.repo.getHealthyProxies();
    this.lastRefreshAt = new Date();
  }

  getActivePool(): ProxyRecord[] {
    return this.healthy;
  }

  getLastRefreshAt(): Date | null {
    return this.lastRefreshAt;
  }

  getRecentFailures(): RecentFailure[] {
    return [...this.recentFailures].reverse();
  }

  /** Selection summary for observability. */
  getSelectionStats(now: number = Date.now()): {
    hotPoolSize: number;
    exploreSelections: number;
    exploitSelections: number;
  } {
    const hotWindow = this.cfg.env.HOT_SUCCESS_WINDOW_MS;
    let hot = 0;
    for (const ev of this.gatewayEvidence.values()) {
      if (ev.lastSuccessAt != null && now - ev.lastSuccessAt <= hotWindow) hot++;
    }
    let explore = 0;
    let exploit = 0;
    for (const n of this.exploreSelections.values()) explore += n;
    for (const n of this.exploitSelections.values()) exploit += n;
    return { hotPoolSize: hot, exploreSelections: explore, exploitSelections: exploit };
  }

  /** Per-source real-gateway attempt/success stats (observability). */
  getSourceStats(): Record<string, SourceStats> {
    const out: Record<string, SourceStats> = {};
    for (const [src, s] of this.sourceStats) out[src] = { ...s };
    return out;
  }

  private selectionParams(): SelectionParams {
    const env = this.cfg.env;
    return {
      hotWindowMs: env.HOT_SUCCESS_WINDOW_MS,
      decayMs: env.PROD_QUALITY_DECAY_MS,
      failurePenalty: env.GATEWAY_FAILURE_PENALTY,
      confidenceMin: env.SOURCE_CONFIDENCE_MIN,
      medianLatencyFallbackMs: 3000,
    };
  }

  /** Select a weighted-random healthy upstream for a gateway request. */
  selectUpstream(
    excludeIds?: Set<number>,
    now: number = Date.now()
  ): ProxyRecord | null {
    const exclusions = new Set(excludeIds ?? []);
    for (const [id, until] of this.cooldownUntil) {
      if (until > now) exclusions.add(id);
      else this.cooldownUntil.delete(id);
    }
    const usable = this.healthy.filter((p) =>
      isUsableForGateway({
        status: p.status,
        quarantined_until: p.quarantined_until,
        score: p.score,
        minHealthyScore: this.cfg.env.MIN_HEALTHY_SCORE,
      })
    );
    if (usable.length === 0) return null;

    const params = this.selectionParams();
    // Exploit/explore split: a controlled fraction samples the wider validated
    // pool, the rest exploit fresh production evidence. This is a probabilistic
    // switch, so diversity is preserved by design.
    const explore = Math.random() < this.cfg.env.GATEWAY_EXPLORATION_FRACTION;
    const weightOf = (p: ProxyRecord) => {
      const ev = this.gatewayEvidence.get(p.id) ?? EMPTY_EVIDENCE;
      const src = this.sourceStats.get(p.source);
      return explore
        ? exploreWeight(p.score, p.latency_ms, latencyWeight, params)
        : exploitWeight(p.score, ev, src, p.latency_ms, latencyWeight, params, now);
    };
    const selected = selectWeighted(usable, this.rotationCtx, {
      excludeIds: exclusions,
      now,
      weightOf,
    });
    if (selected) {
      if (explore) {
        this.exploreSelections.set(selected.id, (this.exploreSelections.get(selected.id) ?? 0) + 1);
      } else {
        this.exploitSelections.set(selected.id, (this.exploitSelections.get(selected.id) ?? 0) + 1);
      }
      const src = this.sourceStats.get(selected.source) ?? { attempts: 0, successes: 0 };
      src.attempts += 1;
      this.sourceStats.set(selected.source, src);
    }
    return selected;
  }

  async onGatewaySuccess(proxyId: number, latencyMs?: number): Promise<void> {
    this.cooldownUntil.delete(proxyId);
    const now = Date.now();
    this.recordGatewayEvidence(proxyId, latencyMs, now, true);
    const proxy = await this.repo.getProxy(proxyId);
    if (!proxy) return;
    // Real production success is the strongest evidence: bump the source's
    // production success count too.
    const src = this.sourceStats.get(proxy.source) ?? { attempts: 0, successes: 0 };
    src.successes += 1;
    this.sourceStats.set(proxy.source, src);
    const wasHealthy = proxy.status === "healthy";
    const updated = await this.repo.recordSuccess(proxy);
    const decision = decideAfterSuccess(updated);
    await this.repo.setStatus(updated.id, decision.status, {
      quarantinedUntil: decision.quarantinedUntil,
    });
    await this.repo.updateScore(updated.id, decision.score);
    await this.repo.clearProbe(updated.id);
    if (!wasHealthy) await this.refreshPool();
  }

  async onGatewayFailure(proxyId: number, error: string, latencyMs?: number): Promise<void> {
    const cooldownMs = this.cfg.env.GATEWAY_FAILURE_COOLDOWN_MS;
    if (cooldownMs > 0) this.cooldownUntil.set(proxyId, Date.now() + cooldownMs);
    const now = Date.now();
    this.recordGatewayEvidence(proxyId, latencyMs, now, false);
    const proxy = await this.repo.getProxy(proxyId);
    if (!proxy) return;
    const updated = await this.repo.recordFailure(proxy, error);
    const decision = decideAfterFailure(updated, this.cfg.env);
    await this.repo.setStatus(updated.id, decision.status, {
      quarantinedUntil: decision.quarantinedUntil,
      lastError: error,
    });
    await this.repo.updateScore(updated.id, decision.score);
    this.pushRecentFailure(updated, error);
    await this.refreshPool();
  }

  private recordGatewayEvidence(
    proxyId: number,
    latencyMs: number | undefined,
    now: number,
    success: boolean
  ): void {
    if (this.gatewayEvidence.size >= PoolManager.MAX_EVIDENCE_ENTRIES) {
      const first = this.gatewayEvidence.keys().next().value as number | undefined;
      if (first !== undefined) this.gatewayEvidence.delete(first);
    }
    // Clone the array so the shared EMPTY_EVIDENCE constant is never mutated.
    const ev =
      this.gatewayEvidence.get(proxyId) ??
      { ...EMPTY_EVIDENCE, recentLatenciesMs: [] };
    if (success) {
      ev.successCount += 1;
      ev.lastSuccessAt = now;
      ev.recentFailures = 0;
      if (latencyMs != null && latencyMs > 0) {
        ev.recentLatenciesMs.push(latencyMs);
        if (ev.recentLatenciesMs.length > PoolManager.MAX_EVIDENCE_LATENCIES) {
          ev.recentLatenciesMs.shift();
        }
      }
    } else {
      ev.recentFailures += 1;
    }
    this.gatewayEvidence.set(proxyId, ev);
  }

  /** Validate new/discovered candidates (bounded batch). */
  async runValidationPass(): Promise<{ checked: number; ok: number }> {
    if (this.validationRunning) return { checked: 0, ok: 0 };
    this.validationRunning = true;
    let ok = 0;
    try {
      const pending = await this.repo.getPending();
      const batch = pending.slice(0, this.cfg.env.VALIDATE_NEW_MAX_BATCH);
      await this.validator.validateBatch(batch, async (id, result) => {
        if (result.ok) ok++;
        await this.applyValidationResult(id, result);
      });
      return { checked: batch.length, ok };
    } finally {
      this.validationRunning = false;
      await this.refreshPool();
    }
  }

  /** Recheck healthy + degraded proxies so stale state is corrected. */
  async runRecheckPass(): Promise<{ checked: number; ok: number }> {
    if (this.checkRunning) return { checked: 0, ok: 0 };
    this.checkRunning = true;
    let ok = 0;
    try {
      const toCheck = await this.repo.getProxiesByStatus(["healthy", "degraded"]);
      const batch = toCheck.slice(0, this.cfg.env.RECHECK_MAX_BATCH);
      await this.validator.validateBatch(batch, async (id, result) => {
        if (result.ok) ok++;
        await this.applyValidationResult(id, result);
      });
      return { checked: batch.length, ok };
    } finally {
      this.checkRunning = false;
      await this.refreshPool();
    }
  }

  /** Retest quarantined proxies whose quarantine window has expired. */
  async runQuarantineRetestPass(): Promise<{ checked: number; recovered: number }> {
    const due = await this.repo.getQuarantinedDue();
    if (due.length === 0) return { checked: 0, recovered: 0 };
    let recovered = 0;
    await this.validator.validateBatch(due, async (id, result) => {
      if (result.ok) recovered++;
      await this.applyValidationResult(id, result);
    });
    await this.refreshPool();
    return { checked: due.length, recovered };
  }

  /** Mark stale discovered/pending candidates as dead. */
  async runCleanup(): Promise<{ dead: number }> {
    const dead = await this.repo.markDead(this.cfg.env.MAX_STALE_AGE_MS);
    await this.refreshPool();
    return { dead };
  }

  private async applyValidationResult(
    proxyId: number,
    result: ValidationResult
  ): Promise<void> {
    const proxy = await this.repo.getProxy(proxyId);
    if (!proxy) return;

    if (result.ok && result.protocol && result.protocol !== proxy.protocol) {
      const alt = await this.repo.upsertCandidate({
        host: proxy.host,
        port: proxy.port,
        protocol: result.protocol,
        source: proxy.source,
      });
      if (alt.id !== proxy.id) {
        await this.repo.applyValidationResult(alt.id, result);
        const altUpdated = await this.repo.getProxy(alt.id);
        if (altUpdated) {
          const decision = decideAfterSuccess(altUpdated);
          await this.repo.setStatus(altUpdated.id, "healthy", {
            quarantinedUntil: null,
          });
          await this.repo.updateScore(altUpdated.id, decision.score);
        }
        await this.repo.recordFailure(proxy, `working protocol is ${result.protocol}`);
        const failed = await this.repo.getProxy(proxy.id);
        if (failed) {
          const fDecision = decideAfterFailure(failed, this.cfg.env);
          await this.repo.setStatus(failed.id, fDecision.status, {
            quarantinedUntil: fDecision.quarantinedUntil,
          });
          await this.repo.updateScore(failed.id, fDecision.score);
        }
        return;
      }
    }

    const updated = await this.repo.applyValidationResult(proxyId, result);
    if (!updated) return;

    if (result.ok) {
      const decision = decideAfterSuccess(updated);
      await this.repo.setStatus(updated.id, decision.status, {
        quarantinedUntil: decision.quarantinedUntil,
      });
      await this.repo.updateScore(updated.id, decision.score);
      await this.repo.clearProbe(updated.id);
      return;
    }

    // Failure path
    if (updated.status === "pending" || updated.status === "discovered") {
      if (updated.failure_count >= this.cfg.env.VALIDATION_FAILURES_TO_DEAD) {
        await this.repo.setStatus(updated.id, "dead", {
          lastError: result.error,
        });
        await this.repo.updateScore(updated.id, 0);
      }
      return;
    }
    if (updated.status === "quarantined") {
      // quarantine retest failed — mark dead
      await this.repo.setStatus(updated.id, "dead", { lastError: result.error });
      await this.repo.updateScore(updated.id, 0);
      return;
    }
    // healthy / degraded failing a scheduled recheck
    const decision = decideAfterFailure(updated, this.cfg.env);
    await this.repo.setStatus(updated.id, decision.status, {
      quarantinedUntil: decision.quarantinedUntil,
      lastError: result.error,
    });
    await this.repo.updateScore(updated.id, decision.score);
  }

  private pushRecentFailure(proxy: ProxyRecord, error: string): void {
    this.recentFailures.push({
      at: new Date(),
      host: proxy.host,
      port: proxy.port,
      protocol: proxy.protocol,
      error: error.slice(0, 200),
    });
    while (this.recentFailures.length > this.maxRecentFailures) {
      this.recentFailures.shift();
    }
  }
}

export type { ProxyStatus };