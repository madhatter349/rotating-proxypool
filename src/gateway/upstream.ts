import net from "node:net";
import {
  connectWithTimeout,
  httpConnect,
  socks4Connect,
  socks5Connect,
} from "../validate/connect.js";
import type { ProxyProtocol } from "../types.js";

export interface Endpoint {
  host: string;
  port: number;
  protocol?: ProxyProtocol;
}

export interface UpstreamResult {
  socket: net.Socket;
  latencyMs: number;
}

function tunnelHandshake(
  socket: net.Socket,
  upstream: Endpoint,
  target: Endpoint,
  connectTimeoutMs: number
): Promise<void> {
  switch (upstream.protocol) {
    case "socks4":
      return socks4Connect(socket, target.host, target.port, connectTimeoutMs);
    case "socks5":
      return socks5Connect(socket, target.host, target.port, connectTimeoutMs);
    default:
      // http / https upstreams all speak HTTP CONNECT.
      return httpConnect(socket, target.host, target.port, connectTimeoutMs);
  }
}

/**
 * Open a tunneled connection to `target` through an upstream proxy, using the
 * handshake appropriate to the upstream protocol (HTTP CONNECT for http/https,
 * SOCKS greeting + CONNECT for socks4/socks5). Returns the established socket
 * (both directions open, reply bytes fully consumed).
 */
export async function tunnelThrough(
  upstream: Endpoint,
  target: Endpoint,
  connectTimeoutMs: number
): Promise<UpstreamResult> {
  const started = Date.now();
  const socket = await connectWithTimeout(upstream.host, upstream.port, connectTimeoutMs);
  try {
    await tunnelHandshake(socket, upstream, target, connectTimeoutMs);
    socket.setTimeout(0);
    return { socket, latencyMs: Date.now() - started };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * Open a socket to an upstream proxy ready to receive a plain HTTP request.
 * For http/https upstreams this is a raw TCP connection (absolute-form is
 * forwarded to the proxy). For socks4/socks5 upstreams the SOCKS CONNECT
 * tunnel to `target` is established first (origin-form will be forwarded).
 */
export async function connectUpstream(
  upstream: Endpoint,
  target: Endpoint,
  connectTimeoutMs: number
): Promise<net.Socket> {
  const isSocks = upstream.protocol === "socks4" || upstream.protocol === "socks5";
  if (isSocks) {
    const { socket } = await tunnelThrough(upstream, target, connectTimeoutMs);
    return socket;
  }
  return connectWithTimeout(upstream.host, upstream.port, connectTimeoutMs);
}