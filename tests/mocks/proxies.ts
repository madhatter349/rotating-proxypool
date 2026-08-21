import net from "node:net";
import http from "node:http";
import https from "node:https";
import { MOCK_CERT, MOCK_KEY } from "./cert.js";

export interface MockServer {
  host: string;
  port: number;
  close: () => Promise<void>;
  connectionCount: () => number;
  maxConcurrent?: () => number;
  connectTargets?: () => string[];
}

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.removeListener("error", reject);
      resolve(port);
    });
  });
}

/** A self-signed TLS certificate used by mock HTTPS targets. */
export function selfSignedKeyPair() {
  return { key: MOCK_KEY, cert: MOCK_CERT };
}

export interface HttpProxyMockOptions {
  /** Delay before responding to CONNECT, in ms. */
  connectDelayMs?: number;
  /** Destroy the socket instead of proxying (malformed/dead). */
  destroyAfterConnect?: boolean;
  /** Send garbage bytes after connect. */
  garbage?: boolean;
  /** Fail this fraction of connections (0-1), e.g. 0.5 for intermittent. */
  failureRate?: number;
  /** Always fail CONNECT with 502. */
  rejectConnect?: boolean;
  /** Accept the TCP connection and read the request but never reply (handshake stack). */
  silentConnect?: boolean;
  /** Reply "200 Connection established" to CONNECT but never forward bytes. */
  acceptThenSilent?: boolean;
  /** Reply "200 Connection established" then close before origin bytes. */
  acceptThenClose?: boolean;
  /** SOCKS: reject the greeting with "no acceptable methods" (handshake failure). */
  rejectHandshake?: boolean;
  /** SOCKS5: send the greeting reply byte-by-byte (tests fragmented-reply handling). */
  fragmentedGreeting?: boolean;
}

/**
 * A mock HTTP forward proxy: supports CONNECT tunneling and absolute-URI
 * plain HTTP forwarding. Can simulate slow / dead / malformed / intermittent
 * proxies deterministically.
 */
export async function startHttpProxy(
  opts: HttpProxyMockOptions = {}
): Promise<MockServer> {
  let count = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const sockets = new Set<net.Socket>();
  const connectTargets: string[] = [];
  const server = net.createServer((client) => {
    count++;
    concurrent++;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    if (opts.failureRate && Math.random() < opts.failureRate) {
      concurrent--;
      client.destroy();
      return;
    }
    sockets.add(client);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buf.subarray(0, headerEnd).toString("latin1");
      const leftover = buf.subarray(headerEnd + 4);
      const lines = head.split("\r\n");
      const parts = (lines[0] ?? "").split(" ");
      const method = parts[0] ?? "";
      const target = parts[1] ?? "";
      if (method === "CONNECT") connectTargets.push(target);
      client.removeListener("data", onData);

      if (opts.garbage) {
        client.write("HTTP/1.1 502 Bad Gateway\r\n\r\ngarbage");
        setTimeout(() => client.destroy(), 10);
        return;
      }
      if (opts.destroyAfterConnect) {
        client.destroy();
        return;
      }

      const respond = () => {
        if (method === "CONNECT") {
          if (opts.silentConnect) {
            // Accept the connection and read the request, but never reply.
            return;
          }
          if (opts.rejectConnect) {
            client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            return;
          }
          const [host, portStr] = target.split(":");
          const port = Number(portStr);
          if (!host || !port) {
            client.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            return;
          }
          if (opts.acceptThenSilent) {
            // Confirm the tunnel but never relay bytes (first-byte stall).
            client.write("HTTP/1.1 200 Connection established\r\n\r\n");
            return;
          }
          if (opts.acceptThenClose) {
            client.write("HTTP/1.1 200 Connection established\r\n\r\n");
            setTimeout(() => client.destroy(), 10);
            return;
          }
          const upstream = net.connect(Number(port), host, () => {
            client.write("HTTP/1.1 200 Connection established\r\n\r\n");
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
          client.on("error", () => undefined);
          client.on("close", () => {
            upstream.destroy();
            sockets.delete(client);
          });
          if (leftover.length) upstream.write(leftover);
        } else if (/^https?:\/\//i.test(target)) {
          const url = new URL(target);
          const isHttps = url.protocol === "https:";
          const mod = isHttps ? https : http;
          const req = mod.request(
            {
              host: url.hostname,
              port: url.port ? Number(url.port) : isHttps ? 443 : 80,
              path: url.pathname + url.search,
              method,
              headers: parseHeaders(lines),
            },
            (res) => {
              client.write(
                `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ""}\r\n` +
                  "Connection: close\r\n\r\n"
              );
              res.pipe(client);
            }
          );
          req.on("error", () => {
            client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            client.destroy();
          });
          req.write(leftover);
          req.end();
        } else {
          client.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        }
      };

      if (opts.connectDelayMs) setTimeout(respond, opts.connectDelayMs);
      else respond();
    };
    client.on("data", onData);
    client.on("error", () => undefined);
    client.on("close", () => {
      sockets.delete(client);
      concurrent--;
    });
  });

  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    connectionCount: () => count,
    maxConcurrent: () => maxConcurrent,
    connectTargets: () => [...connectTargets],
  };
}

function parseHeaders(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** A mock SOCKS5 proxy (no auth) that tunnels to any target. */
export async function startSocks5Proxy(
  opts: HttpProxyMockOptions = {}
): Promise<MockServer> {
  let count = 0;
  const server = net.createServer((client) => {
    count++;
    if (opts.failureRate && Math.random() < opts.failureRate) {
      client.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    let state: "greet" | "request" = "greet";
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === "greet") {
        if (buf.length < 3) return;
        if (buf[0] !== 0x05) return client.destroy();
        if (opts.rejectHandshake) {
          // No acceptable authentication methods (SOCKS handshake failure).
          client.write(Buffer.from([0x05, 0xff]));
          return;
        }
        if (opts.fragmentedGreeting) {
          client.write(Buffer.from([0x05]));
          setImmediate(() => client.write(Buffer.from([0x00])));
        } else {
          client.write(Buffer.from([0x05, 0x00]));
        }
        buf = buf.subarray(3);
        state = "request";
      }
      if (state === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let addrLen = 0;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = buf[4] ?? 0;
        if (buf.length < 4 + addrLen + 2) return;
        const port = (buf[4 + addrLen]! << 8) | buf[5 + addrLen]!;
        let host: string;
        if (atyp === 0x01) host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        else if (atyp === 0x03) host = buf.subarray(5, 5 + addrLen).toString("utf8");
        else return client.destroy();
        if (opts.destroyAfterConnect) {
          client.destroy();
          return;
        }
        const upstream = net.connect(port, host, () => {
          client.removeListener("data", onData);
          client.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x01]),
              Buffer.from([0, 0, 0, 0]),
              Buffer.from([0, 0]),
            ])
          );
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("error", () => undefined);
        client.on("close", () => upstream.destroy());
      }
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connectionCount: () => count,
  };
}

/** A mock SOCKS4a proxy (no auth). */
export async function startSocks4Proxy(
  opts: HttpProxyMockOptions = {}
): Promise<MockServer> {
  let count = 0;
  const server = net.createServer((client) => {
    count++;
    if (opts.failureRate && Math.random() < opts.failureRate) {
      client.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      if (buf[0] !== 0x04 || buf[1] !== 0x01) return client.destroy();
      const port = (buf[2]! << 8) | buf[3]!;
      const ip = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      // find user null terminator, then optional hostname (SOCKS4a)
      let rest = buf.subarray(8);
      const userEnd = rest.indexOf(0);
      if (userEnd === -1) return;
      rest = rest.subarray(userEnd + 1);
      let host: string;
      if (buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0) {
        // SOCKS4a: hostname follows
        const hostEnd = rest.indexOf(0);
        if (hostEnd === -1) return;
        host = rest.subarray(0, hostEnd).toString("utf8");
      } else {
        host = ip;
      }
      if (opts.destroyAfterConnect) {
        client.destroy();
        return;
      }
      const upstream = net.connect(port, host, () => {
        client.removeListener("data", onData);
        client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => undefined);
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connectionCount: () => count,
  };
}

/**
 * A mock HTTPS server that echoes the client's source IP — used as the
 * validation target and to verify HTTPS works through the gateway.
 */
export async function startHttpsEchoTarget(
  opts: { delayMs?: number; body?: string } = {}
): Promise<MockServer> {
  const { key, cert } = selfSignedKeyPair();
  const server = https.createServer({ key, cert }, (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(opts.body ?? req.socket.remoteAddress ?? "unknown");
    }, opts.delayMs ?? 0);
  });
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connectionCount: () => 0,
  };
}

/** A plain HTTP server for testing non-CONNECT forwarding. */
export async function startHttpEchoTarget(
  opts: { delayMs?: number } = {}
): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host }));
    }, opts.delayMs ?? 0);
  });
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    connectionCount: () => 0,
  };
}

/** Get a free port that is guaranteed closed (for dead-proxy tests). */
export async function getClosedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
