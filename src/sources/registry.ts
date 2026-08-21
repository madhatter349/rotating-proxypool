import type { AppConfig } from "../config.js";
import type {
  ProxyCandidate,
  ProxyProtocol,
  SourceRecord,
} from "../types.js";
import { fetchSource, SourceFetchError } from "./fetcher.js";
import { dedupeCandidates, parseSource } from "./parser.js";

/** The repository surface the source registry depends on. */
export interface SourceRepo {
  ensureSource(name: string, url: string, kind: string): Promise<SourceRecord>;
  listSources(): Promise<SourceRecord[]>;
  getByKey(
    host: string,
    port: number,
    protocol: ProxyProtocol
  ): Promise<{ id: number; status: string } | null>;
  upsertCandidate(candidate: ProxyCandidate): Promise<unknown>;
  recordSourceFetch(
    sourceId: number,
    stats: { candidates: number; unique: number; error?: string | null }
  ): Promise<void>;
}

export interface SourceRefreshResult {
  name: string;
  ok: boolean;
  candidates: number;
  unique: number;
  error?: string;
  durationMs: number;
}

export class SourceRegistry {
  constructor(
    private readonly repo: SourceRepo,
    private readonly cfg: AppConfig
  ) {}

  async ensureSources(): Promise<void> {
    for (const s of this.cfg.sources) {
      await this.repo.ensureSource(s.name, s.url, s.kind);
    }
  }

  async getSources() {
    return this.repo.listSources();
  }

  /**
   * Fetch all enabled sources with bounded concurrency and upsert their
   * candidates into the proxy table. Returns per-source results.
   */
  async refreshAll(): Promise<SourceRefreshResult[]> {
    const sources = (await this.repo.listSources()).filter((s) => s.enabled);
    if (sources.length === 0) return [];

    const concurrency = Math.min(8, sources.length);
    const results: SourceRefreshResult[] = [];
    const queue = [...sources];

    const runWorker = async () => {
      for (;;) {
        const src = queue.shift();
        if (!src) return;
        results.push(await this.refreshOne(src.name, src.kind));
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, () => runWorker())
    );
    return results;
  }

  async refreshOne(name: string, kind: string): Promise<SourceRefreshResult> {
    const start = Date.now();
    const src = (await this.repo.listSources()).find((s) => s.name === name);
    if (!src) {
      return {
        name,
        ok: false,
        candidates: 0,
        unique: 0,
        error: "source not found",
        durationMs: Date.now() - start,
      };
    }

    try {
      const { text } = await fetchSource(src.url, {
        timeoutMs: this.cfg.env.SOURCE_FETCH_TIMEOUT_MS,
        maxBytes: this.cfg.env.SOURCE_MAX_BYTES,
      });

      const parsed = parseSource(text, src.name, kind);
      const deduped = dedupeCandidates(parsed.candidates);
      const rawCount = parsed.candidates.length;

      // Cap how many candidates we ingest per source per refresh. Huge scraped
      // lists (50k+ rows) are overwhelmingly dead proxies; feeding all of them
      // floods the DB far ahead of what validation could ever drain.
      const maxCands = this.cfg.env.SOURCE_MAX_CANDIDATES;
      const toIngest = deduped.slice(0, maxCands);

      // Upsert candidates into the DB (only new ones actually insert).
      let inserted = 0;
      let unique = 0;
      const seen = new Set<string>();
      for (const cand of toIngest) {
        const protocol = cand.protocol === "auto" ? "http" : cand.protocol;
        const key = `${protocol}:${cand.host}:${cand.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique++;
        const before = await this.repo.getByKey(cand.host, cand.port, protocol);
        // Insert new candidates AND resurrect 'dead' rows (upsertCandidate flips
        // a dead row back to pending). Otherwise a proxy that died once could
        // never re-enter the pool even after recovering.
        if (!before || before.status === "dead") {
          await this.repo.upsertCandidate(cand);
          inserted++;
        }
      }

      await this.repo.recordSourceFetch(src.id, {
        candidates: rawCount,
        unique,
      });

      return {
        name,
        ok: true,
        candidates: rawCount,
        unique: inserted,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg =
        err instanceof SourceFetchError ? err.message : (err as Error).message;
      await this.repo.recordSourceFetch(src.id, {
        candidates: 0,
        unique: 0,
        error: msg.slice(0, 300),
      });
      return {
        name,
        ok: false,
        candidates: 0,
        unique: 0,
        error: msg,
        durationMs: Date.now() - start,
      };
    }
  }
}