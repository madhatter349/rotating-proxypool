import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { PoolManager } from "../pool/manager.js";
import type { ProxyRecord } from "../types.js";
import { connectWithTimeout } from "../validate/connect.js";
import { connectUpstream, tunnelThrough } from "./upstream.js";

export interface GatewayStats {
  connections: number;
  connectRequests: number;
  httpRequests: number;
  authFailures: number;
  upstreamFailures: number;
  retries: number;
  /** Requests whose upstream tunnel was established before origin data arrived. */
  tunnelEstablished: number;
  success: number;
  /** Tunnels closed/abandoned before the first origin byte. */
  earlyClose: number;
  startedAt: string;
  // Reliability metrics added for observability.
  totalClientRequests: number;
  firstAttemptSuccess: number;
  retryRecovered: number;
  retryExhausted: number;
  /** Tunnel stalls torn down (first-byte or idle timeout). */
  timeouts: number;
  /** Ring buffer of client-visible success durations (ms). */
  requestDurations: number[];
  /** Upstream selections by protocol. */
  requestsByProtocol: Record<string, number>;
}

export interface GatewayOptions {
  host?: string;
  port: number;
  authRequired: boolean;
  username: string;
  password: string;
  pool: PoolManager;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  /** Max time after a tunnel is established before the first origin byte. */
  tunnelFirstByteTimeoutMs: number;
  /** Max silence on an established tunnel once a response is flowing. */
  tunnelIdleTimeoutMs: number;
  maxHeaderBytes: number;
  maxRetries: number;
  maxConnections: number;
  blockPrivate: boolean;
  log: (msg: string) => void;
}

interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  raw: Buffer;
  leftover: Buffer;
}

function privateBlocked(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const oct = host.split(".").map((o) => Number(o));
  const a = oct[0] ?? 0;
  const b = oct[1] ?? 0;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export class GatewayServer {
  readonly stats: GatewayStats = {
    connections: 0,
    connectRequests: 0,
    httpRequests: 0,
    authFailures: 0,
    upstreamFailures: 0,
    retries: 0,
    tunnelEstablished: 0,
    success: 0,
    earlyClose: 0,
    startedAt: new Date().toISOString(),
    totalClientRequests: 0,
    firstAttemptSuccess: 0,
    retryRecovered: 0,
    retryExhausted: 0,
    timeouts: 0,
    requestDurations: [],
    requestsByProtocol: {},
  };
  /** Keep a bounded sample of recent durations for percentile stats. */
  private static readonly MAX_DURATION_SAMPLES = 200;

  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private closed = false;

  constructor(private readonly opts: GatewayOptions) {
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on("error", (err) => opts.log(`gateway server error: ${err.message}`));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        this.server.removeListener("error", reject);
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    if (this.opts.maxConnections > 0 && this.sockets.size >= this.opts.maxConnections) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    this.stats.connections++;
    socket.setTimeout(this.opts.requestTimeoutMs);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > this.opts.maxHeaderBytes) {
        socket.removeListener("data", onData);
        this.writeError(socket, 431, "Request Header Fields Too Large");
        socket.destroy();
        return;
      }
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.removeListener("data", onData);
      const raw = buf.subarray(0, headerEnd + 4);
      const leftover = buf.subarray(headerEnd + 4);
      const head = this.parseHead(raw, leftover);
      if (!head) {
        this.writeError(socket, 400, "Bad Request");
        socket.destroy();
        return;
      }
      socket.setTimeout(0);
      void this.route(socket, head);
    };
    socket.on("data", onData);
  }

  private parseHead(raw: Buffer, leftover: Buffer): RequestHead | null {
    const text = raw.toString("latin1");
    const lines = text.split("\r\n");
    const requestLine = lines[0] ?? "";
    const parts = requestLine.split(" ");
    if (parts.length < 3) return null;
    const method = parts[0]!;
    const target = parts[1]!;
    const version = parts[2]!;
    if (!/^[A-Z]+$/.test(method) || !/^HTTP\/\d\.\d$/.test(version)) return null;
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { method, target, version, headers, raw, leftover };
  }

  private async route(socket: net.Socket, head: RequestHead): Promise<void> {
    if (!this.checkAuth(head)) {
      this.stats.authFailures++;
      this.writeError(socket, 407, "Proxy Authentication Required", true);
      socket.destroy();
      return;
    }
    if (head.method === "CONNECT") {
      this.stats.connectRequests++;
      await this.handleConnect(socket, head);
      return;
    }
    if (/^https?:\/\//i.test(head.target)) {
      this.stats.httpRequests++;
      await this.handlePlainHttp(socket, head);
      return;
    }
    this.writeError(socket, 400, "Bad Request");
    socket.destroy();
  }

  private checkAuth(head: RequestHead): boolean {
    if (!this.opts.authRequired) return true;
    if (!this.opts.username || !this.opts.password) return false; // fail closed
    const auth = head.headers["proxy-authorization"] ?? head.headers["authorization"];
    if (!auth || !auth.toLowerCase().startsWith("basic ")) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    } catch {
      return false;
    }
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    return safeEqual(user, this.opts.username) && safeEqual(pass, this.opts.password);
  }

  private async handleConnect(socket: net.Socket, head: RequestHead): Promise<void> {
    const target = parseHostPort(head.target);
    if (!target) {
      this.writeError(socket, 400, "Bad Request");
      socket.destroy();
      return;
    }
    if (this.opts.blockPrivate && privateBlocked(target.host)) {
      this.writeError(socket, 403, "Forbidden");
      socket.destroy();
      return;
    }

    const attempts = this.opts.maxRetries + 1;
    const attempted = new Set<number>();
    const started = Date.now();
    const deadlineAt = started + this.opts.requestTimeoutMs;
    for (let i = 0; i < attempts; i++) {
      if (deadlineAt <= Date.now()) break;
      const upstream = this.opts.pool.selectUpstream(attempted);
      if (!upstream) {
        this.finishFail(socket, started);
        this.writeError(socket, 502, "Bad Gateway: no healthy upstream");
        socket.destroy();
        return;
      }
      attempted.add(upstream.id);
      this.stats.requestsByProtocol[upstream.protocol] =
        (this.stats.requestsByProtocol[upstream.protocol] ?? 0) + 1;
      // End-user latency is measured from attempt start (connect/handshake)
      // until the first origin byte flows back, captured on tunnel success.
      const attemptStarted = Date.now();
      try {
        const { socket: upstreamSocket } = await tunnelThrough(
          { host: upstream.host, port: upstream.port, protocol: upstream.protocol },
          target,
          this.opts.connectTimeoutMs,
          deadlineAt
        );
        // Tunnel is up; forwarding client bytes now. Retrying would be unsafe
        // (application traffic may already have reached the origin), so this is
        // the last attempt regardless. Apply tunnel timeouts to abandon stalls.
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        this.stats.tunnelEstablished++;
        this.pipe(
          socket,
          upstreamSocket,
          this.opts.tunnelFirstByteTimeoutMs,
          this.opts.tunnelIdleTimeoutMs,
          upstream,
          () => this.recordOriginSuccess(socket, started, i, upstream, attemptStarted),
          () => this.recordOriginBeforeFirstByteFailure(socket, started)
        );
        return;
      } catch (err) {
        // Pre-forward failure: safe to retry with a different upstream.
        this.stats.upstreamFailures++;
        if (i < attempts - 1) this.stats.retries++;
        void this.opts.pool.onGatewayFailure(upstream.id, (err as Error).message);
      }
    }
    // All attempts failed before forwarding — 502 is the correct answer.
    this.finishFail(socket, started);
    void this.writeError(socket, 502, "Bad Gateway");
    socket.destroy();
  }

  private async handlePlainHttp(socket: net.Socket, head: RequestHead): Promise<void> {
    const attempts = this.opts.maxRetries + 1;
    const attempted = new Set<number>();
    const started = Date.now();
    const deadlineAt = started + this.opts.requestTimeoutMs;
    for (let i = 0; i < attempts; i++) {
      if (deadlineAt <= Date.now()) break;
      const upstream = this.opts.pool.selectUpstream(attempted);
      if (!upstream) {
        this.finishFail(socket, started);
        this.writeError(socket, 502, "Bad Gateway: no healthy upstream");
        socket.destroy();
        return;
      }
      attempted.add(upstream.id);
      this.stats.requestsByProtocol[upstream.protocol] =
        (this.stats.requestsByProtocol[upstream.protocol] ?? 0) + 1;
      const isSocks =
        upstream.protocol === "socks4" || upstream.protocol === "socks5";
      // End-user latency is measured from attempt start until first origin byte.
      const attemptStarted = Date.now();
      let upstreamSocket;
      try {
        const target = this.parseTarget(head.target);
        upstreamSocket = target
          ? await connectUpstream(
              { host: upstream.host, port: upstream.port, protocol: upstream.protocol },
              target,
              this.opts.connectTimeoutMs,
              deadlineAt
            )
          : await connectWithTimeout(
              upstream.host,
              upstream.port,
              remainingTimeout(deadlineAt, this.opts.connectTimeoutMs)
            );
        const forwarded = this.rewriteForwardedHead(head, isSocks);
        upstreamSocket.write(forwarded.raw);
        if (head.leftover.length && !isSocks) upstreamSocket.write(head.leftover);
        // Bytes forwarded; retrying is unsafe. Apply tunnel timeouts to abandon stalls.
        this.stats.tunnelEstablished++;
        this.pipe(
          socket,
          upstreamSocket,
          this.opts.tunnelFirstByteTimeoutMs,
          this.opts.tunnelIdleTimeoutMs,
          upstream,
          () => this.recordOriginSuccess(socket, started, i, upstream, attemptStarted),
          () => this.recordOriginBeforeFirstByteFailure(socket, started)
        );
        return;
      } catch (err) {
        if (upstreamSocket) upstreamSocket.destroy();
        this.stats.upstreamFailures++;
        if (i < attempts - 1) this.stats.retries++;
        void this.opts.pool.onGatewayFailure(upstream.id, (err as Error).message);
      }
    }
    this.finishFail(socket, started);
    void this.writeError(socket, 502, "Bad Gateway");
    socket.destroy();
  }

  /** Record a client-visible success. Duration captured once on socket close,
   *  capped so an abandoned/stalled tunnel cannot inflate the sample. */
  private finishSuccess(socket: net.Socket, started: number): void {
    this.stats.totalClientRequests++;
    let done = false;
    const push = () => {
      if (done) return;
      done = true;
      this.pushDuration(Date.now() - started);
    };
    socket.once("close", push);
    const cap = setTimeout(
      push,
      Math.max(this.opts.tunnelFirstByteTimeoutMs, this.opts.tunnelIdleTimeoutMs)
    );
    cap.unref?.();
    socket.once("close", () => clearTimeout(cap));
  }

  /** Record a client-visible failure that ended the request (no success). */
  private finishFail(socket: net.Socket, started: number): void {
    this.stats.totalClientRequests++;
    this.stats.retryExhausted++;
    this.pushDuration(Date.now() - started);
  }

  private recordOriginSuccess(
    socket: net.Socket,
    started: number,
    attempt: number,
    upstream: ProxyRecord,
    attemptStartedMs: number
  ): void {
    this.stats.success++;
    if (attempt === 0) this.stats.firstAttemptSuccess++;
    else this.stats.retryRecovered++;
    this.finishSuccess(socket, started);
    // End-user first-byte latency for THIS selected attempt is recorded as
    // production latency evidence (positive finite, else ignore). Only the
    // successful attempt reports here, so failed attempts are never rewarded.
    const latencyMs = Date.now() - attemptStartedMs;
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      void this.opts.pool.onGatewaySuccess(upstream.id, latencyMs);
    }
  }

  private recordOriginBeforeFirstByteFailure(
    socket: net.Socket,
    started: number
  ): void {
    this.stats.earlyClose++;
    this.finishClientFailure(socket, started);
  }

  private finishClientFailure(socket: net.Socket, started: number): void {
    this.stats.totalClientRequests++;
    this.pushDuration(Date.now() - started);
    socket.destroy();
  }

  private pushDuration(ms: number): void {
    this.stats.requestDurations.push(ms);
    if (this.stats.requestDurations.length > GatewayServer.MAX_DURATION_SAMPLES) {
      this.stats.requestDurations.shift();
    }
  }

  /**
   * Rebuild the forwarded request head for an upstream proxy. For http/https
   * upstreams the request line stays absolute-form (the proxy routes it). For
   * socks upstreams a tunnel to the origin already exists, so the request line
   * is origin-form. Hop-by-hop headers are stripped and connection closed.
   */
  private rewriteForwardedHead(head: RequestHead, isSocks: boolean): { raw: Buffer } {
    const hopByHop = new Set([
      "connection",
      "proxy-connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
    const lines = head.raw.toString("latin1").split("\r\n");
    const out: string[] = [];
    let target = head.target;
    if (isSocks) {
      try {
        const u = new URL(head.target);
        target = u.pathname + u.search || "/";
      } catch {
        // leave as-is
      }
    }
    out.push(`${head.method} ${target} ${head.version}`);
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const idx = line.indexOf(":");
      const key = idx === -1 ? "" : line.slice(0, idx).trim().toLowerCase();
      if (hopByHop.has(key)) continue;
      out.push(line);
    }
    if (!head.headers.host) {
      try {
        const u = new URL(head.target);
        out.push(`Host: ${u.host}`);
      } catch {
        // leave as-is
      }
    }
    out.push("Connection: close");
    return { raw: Buffer.from(out.join("\r\n") + "\r\n\r\n", "latin1") };
  }

  /** Parse an absolute-form URL request target into host/port for SOCKS tunneling. */
  private parseTarget(target: string): { host: string; port: number } | null {
    try {
      const u = new URL(target);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
    } catch {
      return null;
    }
  }

  private pipe(
    client: net.Socket,
    upstream: net.Socket,
    firstByteTimeoutMs: number,
    idleTimeoutMs: number,
    upstreamRecord: ProxyRecord,
    onFirstByte: () => void,
    onBeforeFirstByteClose: () => void
  ): void {
    client.pipe(upstream);
    upstream.pipe(client);
    let cleaned = false;
    let gotFirstByte = false;
    let outcomeRecorded = false;
    const recordBeforeFirstByteClose = () => {
      if (outcomeRecorded || gotFirstByte) return;
      outcomeRecorded = true;
      onBeforeFirstByteClose();
    };
    const teardown = (reason?: string, timedOut = false) => {
      if (cleaned) return;
      cleaned = true;
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.destroy();
      upstream.destroy();
      if (reason) {
        this.stats.upstreamFailures++;
        if (timedOut) this.stats.timeouts++;
        void this.opts.pool.onGatewayFailure(
          upstreamRecord.id,
          `tunnel stalled: ${reason}`
        );
      }
      recordBeforeFirstByteClose();
    };
    // Abandon an upstream that accepts a tunnel but never delivers origin bytes,
    // or that goes completely silent mid-stream. Node resets this inactivity
    // timer on every byte, so only genuinely stalled tunnels are affected.
    const onStall = () => {
      const reason = gotFirstByte
        ? `idle ${Math.round(idleTimeoutMs / 1000)}s without data`
        : `no first byte within ${Math.round(firstByteTimeoutMs / 1000)}s`;
      this.opts.log(
        `[gateway] abandoning upstream ${upstreamRecord.host}:${upstreamRecord.port} (${upstreamRecord.protocol}): ${reason}`
      );
      teardown(reason, true);
    };
    upstream.setTimeout(firstByteTimeoutMs, onStall);
    upstream.on("data", () => {
      if (!gotFirstByte) {
        gotFirstByte = true;
        outcomeRecorded = true;
        upstream.setTimeout(idleTimeoutMs, onStall);
        onFirstByte();
      }
    });
    upstream.on("close", () => {
      if (!gotFirstByte) teardown("upstream closed before first origin byte");
      else teardown();
    });
    upstream.on("error", (err) => {
      if (!gotFirstByte) teardown(`upstream error: ${err.message}`);
      else teardown();
    });
    client.on("error", () => undefined);
    client.on("close", () => teardown());
  }

  private writeError(
    socket: net.Socket,
    code: number,
    message: string,
    proxyAuth = false
  ): void {
    const reason = reasonPhrase(code);
    let body = `HTTP/1.1 ${code} ${reason}\r\n`;
    if (proxyAuth) body += `Proxy-Authenticate: Basic realm="proxypool"\r\n`;
    body += `Content-Length: 0\r\nConnection: close\r\n\r\n`;
    socket.write(body);
  }
}

export function parseHostPort(target: string): { host: string; port: number } | null {
  const idx = target.lastIndexOf(":");
  if (idx === -1) return null;
  const host = target.slice(0, idx);
  const portStr = target.slice(idx + 1);
  if (!host) return null;
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  // host may be bracketed IPv6
  const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!/^[a-z0-9.:\-_]+$/i.test(cleanHost)) return null;
  return { host: cleanHost, port };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function reasonPhrase(code: number): string {
  const map: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    407: "Proxy Authentication Required",
    431: "Request Header Fields Too Large",
    502: "Bad Gateway",
  };
  return map[code] ?? "Error";
}

function remainingTimeout(deadlineAt: number, maxTimeoutMs: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("gateway request deadline exceeded");
  return Math.min(maxTimeoutMs, remaining);
}
