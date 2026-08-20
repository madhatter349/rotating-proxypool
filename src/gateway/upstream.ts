import net from "node:net";
import { connectWithTimeout, ProxyHandshakeError } from "../validate/connect.js";

export interface Endpoint {
  host: string;
  port: number;
}

export interface UpstreamResult {
  socket: net.Socket;
  latencyMs: number;
}

/**
 * Open a tunneled connection to `target` through an upstream proxy using
 * HTTP CONNECT. Returns the established socket (both directions open).
 */
export async function tunnelThrough(
  upstream: Endpoint,
  target: Endpoint,
  connectTimeoutMs: number
): Promise<UpstreamResult> {
  const started = Date.now();
  const socket = await connectWithTimeout(upstream.host, upstream.port, connectTimeoutMs);
  try {
    const hostPort = `${target.host}:${target.port}`;
    const response = await requestProxy(
      socket,
      `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      connectTimeoutMs
    );
    if (response.status !== 200) {
      throw new ProxyHandshakeError(
        `upstream CONNECT returned HTTP ${response.status}`,
        "http-handshake"
      );
    }
    socket.setTimeout(0);
    return { socket, latencyMs: Date.now() - started };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
}

function requestProxy(
  socket: net.Socket,
  request: string,
  timeoutMs: number
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new ProxyHandshakeError("upstream: timeout waiting for response", "http-handshake"));
    }, timeoutMs);
    const finish = (err?: Error, res?: ProxyResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.setTimeout(0);
      if (err) reject(err);
      else resolve(res!);
    };

    socket.setTimeout(timeoutMs, () =>
      finish(new ProxyHandshakeError("upstream: socket timeout", "http-handshake"))
    );
    socket.once("error", (err) =>
      finish(new ProxyHandshakeError(`upstream: ${err.message}`, "http-handshake"))
    );
    socket.on("data", function onData(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buf.length > 64 * 1024) {
          finish(new ProxyHandshakeError("upstream: response too large", "http-handshake"));
        }
        return;
      }
      socket.removeListener("data", onData);
      const statusLine = buf.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const headers: Record<string, string> = {};
      const lines = buf.subarray(0, headerEnd).toString("latin1").split("\r\n").slice(1);
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      finish(undefined, { status, headers });
    });
    socket.once("close", () =>
      finish(new ProxyHandshakeError("upstream: socket closed", "http-handshake"))
    );
    socket.write(request);
  });
}

/**
 * Connect a client socket to an upstream HTTP proxy and forward the exact
 * request head (already in absolute-form) for plain HTTP proxying.
 */
export async function connectUpstream(
  upstream: Endpoint,
  connectTimeoutMs: number
): Promise<net.Socket> {
  return connectWithTimeout(upstream.host, upstream.port, connectTimeoutMs);
}