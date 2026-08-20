import net from "node:net";
import tls from "node:tls";

export class ProxyHandshakeError extends Error {
  constructor(
    message: string,
    readonly phase: string
  ) {
    super(message);
    this.name = "ProxyHandshakeError";
  }
}

export function connectWithTimeout(
  host: string,
  port: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", (err) =>
      fail(new ProxyHandshakeError(`connect: ${err.message}`, "connect"))
    );
    socket.once("timeout", () =>
      fail(
        new ProxyHandshakeError(
          `connect: timed out after ${timeoutMs}ms`,
          "connect"
        )
      )
    );
  });
}

interface ReadResult {
  statusLine: string;
  headers: Record<string, string>;
  body: Buffer;
}

function parseBuffer(buf: Buffer): ReadResult {
  const headerEnd = buf.indexOf("\r\n\r\n");
  const headerBlock = buf.subarray(0, headerEnd === -1 ? buf.length : headerEnd);
  const lines = headerBlock.toString("latin1").split("\r\n");
  const statusLine = lines[0] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(":");
    if (idx === -1) continue;
    const key = lines[i]!.slice(0, idx).trim().toLowerCase();
    const val = lines[i]!.slice(idx + 1).trim();
    headers[key] = val;
  }
  const bodyStart = headerEnd === -1 ? buf.length : headerEnd + 4;
  const body = buf.subarray(bodyStart);
  return { statusLine, headers, body };
}

function getContentLength(headerBlock: Buffer): number | null {
  const m = /content-length:\s*(\d+)/i.exec(headerBlock.toString("latin1"));
  return m ? Number(m[1]) : null;
}

/** Perform an HTTP CONNECT through the proxy socket and wait for 200. */
export function httpConnect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new ProxyHandshakeError("http connect: timeout", "http-handshake"));
    }, timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs, () =>
      finish(new ProxyHandshakeError("http connect: socket timeout", "http-handshake"))
    );
    socket.once("error", (err) =>
      finish(new ProxyHandshakeError(`http connect: ${err.message}`, "http-handshake"))
    );
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.removeListener("data", onData);
      const res = parseBuffer(buf);
      const status = Number(res.statusLine.split(" ")[1] ?? 0);
      if (status === 200) {
        finish();
      } else if (status === 407) {
        finish(new ProxyHandshakeError("http connect: proxy requires auth (407)", "http-handshake"));
      } else {
        finish(
          new ProxyHandshakeError(
            `http connect: unexpected status ${status}`,
            "http-handshake"
          )
        );
      }
    };
    socket.on("data", onData);

    const hostPort = `${targetHost}:${targetPort}`;
    socket.write(
      `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Connection: keep-alive\r\n\r\n`
    );
  });
}

/** SOCKS5 handshake: greet (no-auth) then CONNECT to target (domain or IP). */
export function socks5Connect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new ProxyHandshakeError("socks5: timeout", "socks-handshake"));
    }, timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs, () =>
      finish(new ProxyHandshakeError("socks5: socket timeout", "socks-handshake"))
    );
    socket.once("error", (err) =>
      finish(new ProxyHandshakeError(`socks5: ${err.message}`, "socks-handshake"))
    );

    // Greeting
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    socket.once("data", function onGreet(chunk: Buffer) {
      const greet = chunk[0] === 0x05 && chunk[1] === 0x00;
      if (!greet) {
        return finish(
          new ProxyHandshakeError("socks5: greeting rejected", "socks-handshake")
        );
      }
      // Build CONNECT request
      const hostBuf = Buffer.from(targetHost, "utf8");
      const isIp = net.isIP(targetHost);
      const atyp = isIp === 4 ? 0x01 : isIp === 6 ? 0x04 : 0x03;
      let addrBuf: Buffer;
      if (atyp === 0x01) addrBuf = ip4ToBuf(targetHost);
      else if (atyp === 0x04) addrBuf = ip6ToBuf(targetHost);
      else addrBuf = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
      const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
      const request = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, atyp]),
        addrBuf,
        portBuf,
      ]);
      socket.write(request);
      let reply = Buffer.alloc(0);
      const onReply = (chunk: Buffer) => {
        reply = Buffer.concat([reply, chunk]);
        if (reply.length < 2) return;
        if (reply[0] !== 0x05) {
          return finish(
            new ProxyHandshakeError("socks5: bad reply version", "socks-handshake")
          );
        }
        const code = reply[1];
        if (code !== 0x00) {
          const msg =
            code === 0x01
              ? "general failure"
              : code === 0x02
                ? "connection not allowed"
                : code === 0x03
                  ? "network unreachable"
                  : code === 0x04
                    ? "host unreachable"
                    : code === 0x05
                      ? "connection refused"
                      : `code ${code}`;
          return finish(
            new ProxyHandshakeError(`socks5: ${msg}`, "socks-handshake")
          );
        }
        // Success: consume the entire reply (VER REP RSV ATYP BND.ADDR BND.PORT).
        const atyp = reply[3] ?? 0x01;
        let addrLen = 0;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = reply[4] ?? 0;
        const total = 4 + addrLen + 2;
        if (reply.length < total) return;
        socket.removeListener("data", onReply);
        finish();
      };
      socket.on("data", onReply);
    });
  });
}

/** SOCKS4a handshake with domain-name target support. */
export function socks4Connect(
  socket: net.Socket,
  targetHost: string,
  targetPort: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new ProxyHandshakeError("socks4: timeout", "socks-handshake"));
    }, timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs, () =>
      finish(new ProxyHandshakeError("socks4: socket timeout", "socks-handshake"))
    );
    socket.once("error", (err) =>
      finish(new ProxyHandshakeError(`socks4: ${err.message}`, "socks-handshake"))
    );

    const isIp = net.isIP(targetHost);
    let ipBuf: Buffer;
    let domainBuf: Buffer;
    if (isIp === 4) {
      ipBuf = ip4ToBuf(targetHost);
      domainBuf = Buffer.alloc(0);
    } else {
      // SOCKS4a: 0.0.0.1 marker + null-terminated hostname
      ipBuf = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      domainBuf = Buffer.concat([Buffer.from(targetHost, "utf8"), Buffer.from([0x00])]);
    }
    const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
    const request = Buffer.concat([
      Buffer.from([0x04, 0x01]),
      portBuf,
      ipBuf,
      Buffer.from([0x00]),
      domainBuf,
    ]);
    socket.write(request);
    let reply = Buffer.alloc(0);
    const onReply = (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length < 8) return;
      socket.removeListener("data", onReply);
      if (reply[0] !== 0x00) {
        return finish(
          new ProxyHandshakeError("socks4: bad reply", "socks-handshake")
        );
      }
      if (reply[1] === 0x5a) finish();
      else {
        const code = reply[1] ?? 0;
        const codes: Record<number, string> = {
          0x5b: "request rejected",
          0x5c: "identd unreachable",
          0x5d: "identd mismatch",
        };
        finish(
          new ProxyHandshakeError(
            `socks4: ${codes[code] ?? `code ${code}`}`,
            "socks-handshake"
          )
        );
      }
    };
    socket.on("data", onReply);
  });
}

function ip4ToBuf(ip: string): Buffer {
  return Buffer.from(ip.split(".").map((o) => Number(o)));
}

function ip6ToBuf(ip: string): Buffer {
  const groups = ip.split("::");
  if (groups.length === 2) {
    const left = groups[0] ? groups[0].split(":") : [];
    const right = groups[1] ? groups[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    const full = [...left, ...new Array(missing).fill("0"), ...right];
    return Buffer.from(full.flatMap((p) => hexGroupToBytes(p)));
  }
  const parts = ip.split(":");
  return Buffer.from(parts.flatMap((p) => hexGroupToBytes(p)));
}

function hexGroupToBytes(group: string): number[] {
  const n = Number.parseInt(group || "0", 16);
  return [(n >> 8) & 0xff, n & 0xff];
}

export interface TlsOverSocketOptions {
  servername: string;
  requestPath?: string;
  timeoutMs: number;
  maxBodyBytes: number;
  userAgent?: string;
  /** Trusted CA (PEM). When absent, the default system CAs are used. */
  ca?: string;
}

export interface TlsRequestResult {
  status: number;
  body: Buffer;
  exitIp: string | null;
}

/** Wrap an established proxy tunnel in TLS and issue a GET to the validation target. */
export function tlsRequestOverSocket(
  socket: net.Socket,
  opts: TlsOverSocketOptions
): Promise<TlsRequestResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new ProxyHandshakeError("tls: timeout", "tls"));
    }, opts.timeoutMs);
    const finish = (err?: Error, result?: TlsRequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      if (err) reject(err);
      else resolve(result!);
    };

    const tlsSocket = tls.connect(
      {
        socket,
        ...(net.isIP(opts.servername) ? {} : { servername: opts.servername }),
        rejectUnauthorized: true,
        ...(opts.ca ? { ca: opts.ca } : {}),
      },
      () => {
        tlsSocket.setTimeout(opts.timeoutMs, () =>
          finish(new ProxyHandshakeError("tls: socket timeout", "request"))
        );
        tlsSocket.write(
          `GET ${opts.requestPath ?? "/"} HTTP/1.1\r\n` +
            `Host: ${opts.servername}\r\n` +
            `User-Agent: ${opts.userAgent ?? "rotating-proxypool/1.0"}\r\n` +
            "Connection: close\r\n\r\n"
        );
      }
    );

    tlsSocket.once("error", (err) =>
      finish(new ProxyHandshakeError(`tls: ${err.message}`, "tls"))
    );

    let buf = Buffer.alloc(0);
    tlsSocket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > opts.maxBodyBytes) {
        finish(new ProxyHandshakeError("tls: response too large", "response"));
        return;
      }
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const contentLength = getContentLength(buf.subarray(0, headerEnd));
        const bodyStart = headerEnd + 4;
        const hasBody = contentLength == null || buf.length - bodyStart >= contentLength;
        // Also accept chunked responses ending in final chunk marker
        const chunkedEnd = buf.subarray(buf.length - 5).toString("latin1") === "0\r\n\r\n";
        if (hasBody || chunkedEnd || buf.length - bodyStart > 0) {
          const parsed = parseBuffer(buf);
          const status = Number(parsed.statusLine.split(" ")[1] ?? 0);
          finish(undefined, {
            status,
            body: parsed.body,
            exitIp: extractIp(parsed.body.toString("utf8")),
          });
        }
      }
    });
  });
}

/** Extract the first IP address from a text body (used to capture proxy exit IP). */
export function extractIp(text: string): string | null {
  const v4 = /(?:\d{1,3}\.){3}\d{1,3}/.exec(text);
  const v6 = /[0-9a-f:]+:[0-9a-f:]*(?::\d{1,3}\.){0,3}\d{1,3}[0-9a-f:]*/i.exec(text);
  const match = v4 ?? v6;
  if (!match) return null;
  const ip = match[0];
  // validate IPv4 octets
  if (ip.includes(".")) {
    const octets = ip.split(".");
    if (octets.every((o) => Number(o) <= 255)) return ip;
    return null;
  }
  return ip;
}