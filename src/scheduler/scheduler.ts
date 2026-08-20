import type { PoolManager } from "../pool/manager.js";
import type { SourceRegistry } from "../sources/registry.js";

export interface SchedulerOptions {
  sources: SourceRegistry;
  pool: PoolManager;
  discoveryIntervalMs: number;
  validateNewIntervalMs: number;
  recheckIntervalMs: number;
  retestIntervalMs: number;
  cleanupIntervalMs: number;
  discoveryEnabled: boolean;
  log: (msg: string) => void;
}

export class Scheduler {
  private readonly timers: Array<{ name: string; timer: NodeJS.Timeout }> = [];
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    const schedule = (
      name: string,
      intervalMs: number,
      fn: () => Promise<void>
    ) => {
      const timer = setInterval(() => void this.guard(name, fn), intervalMs);
      timer.unref?.();
      this.timers.push({ name, timer });
      this.opts.log(`[scheduler] ${name} every ${intervalMs}ms`);
    };

    if (this.opts.discoveryEnabled) {
      schedule("discovery", this.opts.discoveryIntervalMs, async () => {
        const results = await this.opts.sources.refreshAll();
        const ok = results.filter((r) => r.ok).length;
        this.opts.log(
          `[scheduler] discovery done: ${ok}/${results.length} sources ok, ` +
            `${results.reduce((a, r) => a + r.unique, 0)} new candidates`
        );
      });
    }

    schedule("validate-new", this.opts.validateNewIntervalMs, async () => {
      const res = await this.opts.pool.runValidationPass();
      if (res.checked > 0) {
        this.opts.log(
          `[scheduler] validation pass: ${res.ok}/${res.checked} ok`
        );
      }
    });

    schedule("recheck", this.opts.recheckIntervalMs, async () => {
      const res = await this.opts.pool.runRecheckPass();
      if (res.checked > 0) {
        this.opts.log(`[scheduler] recheck: ${res.ok}/${res.checked} ok`);
      }
    });

    schedule("quarantine-retest", this.opts.retestIntervalMs, async () => {
      const res = await this.opts.pool.runQuarantineRetestPass();
      if (res.checked > 0) {
        this.opts.log(
          `[scheduler] quarantine retest: ${res.recovered}/${res.checked} recovered`
        );
      }
    });

    schedule("cleanup", this.opts.cleanupIntervalMs, async () => {
      const res = await this.opts.pool.runCleanup();
      if (res.dead > 0) this.opts.log(`[scheduler] cleanup: ${res.dead} marked dead`);
    });
  }

  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.stopped || this.running.has(name)) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.opts.log(`[scheduler] ${name} error: ${(err as Error).message}`);
    } finally {
      this.running.delete(name);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const { name, timer } of this.timers) {
      clearInterval(timer);
      this.opts.log(`[scheduler] stopped ${name}`);
    }
    this.timers.length = 0;
  }
}