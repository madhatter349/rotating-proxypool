import type { AppConfig } from "../config.js";
import type { ProxyCandidate, ProxyRecord, ProxyStatus, ValidationResult } from "../types.js";
import type { Validator } from "../validate/validator.js";
import { decideAfterFailure, decideAfterSuccess } from "./lifecycle.js";
import { createRotationContext, selectWeighted } from "./rotator.js";
import { isUsableForGateway } from "./scoring.js";

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
  readonly maxRecentFailures = 100;

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

  /** Select a weighted-random healthy upstream for a gateway request. */
  selectUpstream(): ProxyRecord | null {
    const usable = this.healthy.filter((p) =>
      isUsableForGateway({
        status: p.status,
        quarantined_until: p.quarantined_until,
        score: p.score,
        minHealthyScore: this.cfg.env.MIN_HEALTHY_SCORE,
      })
    );
    return selectWeighted(usable, this.rotationCtx);
  }

  async onGatewaySuccess(proxyId: number): Promise<void> {
    const proxy = await this.repo.getProxy(proxyId);
    if (!proxy) return;
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

  async onGatewayFailure(proxyId: number, error: string): Promise<void> {
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