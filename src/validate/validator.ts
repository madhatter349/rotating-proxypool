import type { AppConfig } from "../config.js";
import type { ProxyRecord, ValidationResult } from "../types.js";
import {
  connectWithTimeout,
  httpConnect,
  ProxyHandshakeError,
  socks4Connect,
  socks5Connect,
  tlsRequestOverSocket,
} from "./connect.js";

export interface ValidatorOptions {
  connectTimeoutMs?: number;
  validationTimeoutMs?: number;
  concurrency?: number;
  targets?: string[];
  /** PEM CA used to verify the HTTPS validation target (for tests). */
  tlsCa?: string;
}

interface Target {
  host: string;
  port: number;
  path: string;
}

function parseTargets(targets: string[]): Target[] {
  const out: Target[] = [];
  for (const t of targets) {
    try {
      const url = new URL(t);
      if (url.protocol !== "https:") continue;
      out.push({
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + url.search,
      });
    } catch {
      // ignore malformed target
    }
  }
  return out;
}

export class Validator {
  private readonly targets: Target[];
  private targetCursor = 0;
  private readonly concurrency: number;
  private readonly connectTimeoutMs: number;
  private readonly validationTimeoutMs: number;
  private readonly tlsCa?: string;

  constructor(cfg: AppConfig, opts: ValidatorOptions = {}) {
    this.targets = parseTargets(opts.targets ?? cfg.validationTargets);
    this.concurrency = opts.concurrency ?? cfg.env.VALIDATION_CONCURRENCY;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? cfg.env.CONNECT_TIMEOUT_MS;
    this.validationTimeoutMs =
      opts.validationTimeoutMs ?? cfg.env.VALIDATION_TIMEOUT_MS;
    this.tlsCa = opts.tlsCa;
  }

  /**
   * Validate a single proxy against the configured HTTPS target.
   * `protocolHint` is the protocol to try; "auto" tries http -> socks5 -> socks4.
   */
  async validateProxy(
    proxy: Pick<ProxyRecord, "host" | "port" | "protocol" | "probe">,
    target?: Target
  ): Promise<ValidationResult> {
    const t = target ?? this.targets[0];
    if (!t) {
      return {
        ok: false,
        latencyMs: 0,
        exitIp: null,
        supportsHttps: false,
        error: "no validation targets configured",
        protocol: null,
      };
    }

    const started = Date.now();
    const protocols: ProxyRecord["protocol"][] =
      proxy.protocol === "http" && proxy.probe
        ? ["http", "socks5", "socks4"]
        : [proxy.protocol];

    let lastError: string | null = null;
    let lastProtocol: ProxyRecord["protocol"] | null = null;

    for (const protocol of protocols) {
      if (Date.now() - started > this.validationTimeoutMs) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          exitIp: null,
          supportsHttps: false,
          error: lastError ?? "validation deadline exceeded",
          protocol: lastProtocol,
        };
      }
      const result = await this.tryProtocol(
        proxy.host,
        proxy.port,
        protocol as ProxyRecord["protocol"],
        t,
        Date.now() - started
      );
      lastError = result.error;
      lastProtocol = result.protocol;
      if (result.ok) return result;
    }

    return {
      ok: false,
      latencyMs: Date.now() - started,
      exitIp: null,
      supportsHttps: false,
      error: lastError ?? "all protocols failed",
      protocol: lastProtocol,
    };
  }

  private async tryProtocol(
    host: string,
    port: number,
    protocol: ProxyRecord["protocol"],
    target: Target,
    alreadySpentMs: number
  ): Promise<ValidationResult> {
    const remaining = Math.max(500, this.validationTimeoutMs - alreadySpentMs);
    let socket;
    try {
      socket = await connectWithTimeout(host, port, this.connectTimeoutMs);
      const stepStart = Date.now();
      switch (protocol) {
        case "http":
        case "https":
          await httpConnect(socket, target.host, target.port, this.connectTimeoutMs);
          break;
        case "socks5":
          await socks5Connect(socket, target.host, target.port, this.connectTimeoutMs);
          break;
        case "socks4":
          await socks4Connect(socket, target.host, target.port, this.connectTimeoutMs);
          break;
      }

      const tls = await tlsRequestOverSocket(socket, {
        servername: target.host,
        requestPath: target.path,
        timeoutMs: Math.min(this.connectTimeoutMs, remaining),
        maxBodyBytes: 64 * 1024,
        ca: this.tlsCa,
      });

      if (tls.status >= 200 && tls.status < 400) {
        return {
          ok: true,
          latencyMs: Date.now() - stepStart,
          exitIp: tls.exitIp,
          supportsHttps: true,
          error: null,
          protocol,
        };
      }
      return {
        ok: false,
        latencyMs: Date.now() - stepStart,
        exitIp: null,
        supportsHttps: true,
        error: `target returned HTTP ${tls.status}`,
        protocol,
      };
    } catch (err) {
      const msg =
        err instanceof ProxyHandshakeError ? err.message : (err as Error).message;
      return {
        ok: false,
        latencyMs: 0,
        exitIp: null,
        supportsHttps: false,
        error: msg,
        protocol,
      };
    } finally {
      socket?.destroy();
    }
  }

  /**
   * Validate a batch of proxies with bounded concurrency.
   * Calls `onResult(proxy, result)` for each finished item.
   */
  async validateBatch(
    proxies: Array<Pick<ProxyRecord, "id" | "host" | "port" | "protocol" | "probe">>,
    onResult: (proxyId: number, result: ValidationResult) => void | Promise<void>
  ): Promise<void> {
    const queue = [...proxies];
    const workers = Math.max(1, Math.min(this.concurrency, proxies.length || 1));
    const runWorker = async () => {
      for (;;) {
        const proxy = queue.shift();
        if (!proxy) return;
        try {
          const target = this.targets.length
            ? this.targets[this.targetCursor++ % this.targets.length]
            : undefined;
          const result = await this.validateProxy(proxy, target);
          await onResult(proxy.id, result);
        } catch (err) {
          await onResult(proxy.id, {
            ok: false,
            latencyMs: 0,
            exitIp: null,
            supportsHttps: false,
            error: (err as Error).message,
            protocol: null,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => runWorker()));
  }
}

/** A minimal semaphore for other bounded work if needed. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
