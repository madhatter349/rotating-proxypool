import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { parseHostPort } from "../../src/gateway/server.js";
import { MOCK_CERT } from "../mocks/cert.js";

export interface Creds {
  username: string;
  password: string;
}

export function proxyAuthHeader(creds: Creds): string {
  return "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
}

export interface ConnectResult {
  socket: net.Socket;
  statusCode: number;
}

/**
 * Open a CONNECT tunnel to host:port through the gateway at gatewayHost:port.
 * Returns the established socket on 2xx, otherwise the socket is destroyed
 * and the status code is returned.
 */
export function connectViaProxy(
  gatewayHost: string,
  gatewayPort: number,
  target: { host: string; port: number },
  creds?: Creds
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(gatewayPort, gatewayHost);
    let buf = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("connectViaProxy: timeout"));
    }, 15000);
    const fail = (err: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      reject(err);
    };
    socket.on("error", (err) => fail(err));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      clearTimeout(timeout);
      socket.removeAllListeners("data");
      const statusLine = buf.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] ?? "";
      const statusCode = Number(statusLine.split(" ")[1] ?? 0);
      if (statusCode >= 200 && statusCode < 300) {
        resolve({ socket, statusCode });
      } else {
        socket.destroy();
        resolve({ socket, statusCode });
      }
    });
    socket.on("connect", () => {
      const hostPort = `${target.host}:${target.port}`;
      let req =
        `CONNECT ${hostPort} HTTP/1.1\r\n` +
        `Host: ${hostPort}\r\n`;
      if (creds) req += `Proxy-Authorization: ${proxyAuthHeader(creds)}\r\n`;
      req += "\r\n";
      socket.write(req);
    });
  });
}

/**
 * Perform an HTTPS GET to https://host:port/path through the gateway using
 * CONNECT tunneling, returning { statusCode, body }.
 */
export async function httpsGetViaProxy(
  gatewayHost: string,
  gatewayPort: number,
  targetUrl: string,
  creds?: Creds,
  opts: { rejectUnauthorized?: boolean; ca?: string } = {}
): Promise<{ statusCode: number; body: string }> {
  const url = new URL(targetUrl);
  const port = url.port ? Number(url.port) : 443;
  const { socket, statusCode } = await connectViaProxy(
    gatewayHost,
    gatewayPort,
    { host: url.hostname, port },
    creds
  );
  if (statusCode !== 200) {
    socket.destroy();
    return { statusCode, body: "" };
  }
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect(
      {
        socket,
        ...(net.isIP(url.hostname) ? {} : { servername: url.hostname }),
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
        ...(opts.ca ? { ca: opts.ca } : { ca: MOCK_CERT }),
      },
      () => {
        tlsSocket.write(
          `GET ${url.pathname + url.search} HTTP/1.1\r\n` +
            `Host: ${url.hostname}\r\nConnection: close\r\n\r\n`
        );
      }
    );
    const timeout = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error("httpsGetViaProxy: timeout"));
    }, 15000);
    let body = Buffer.alloc(0);
    tlsSocket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    tlsSocket.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    tlsSocket.on("end", () => {
      clearTimeout(timeout);
      const text = body.toString("utf8");
      const headerEnd = text.indexOf("\r\n\r\n");
      const statusLine = text.split("\r\n")[0] ?? "";
      const code = Number(statusLine.split(" ")[1] ?? 0);
      const respBody = headerEnd === -1 ? text : text.slice(headerEnd + 4);
      tlsSocket.destroy();
      resolve({ statusCode: code, body: respBody });
    });
  });
}

/** Perform a plain HTTP GET through the gateway using absolute-URI form. */
export function httpGetViaProxy(
  gatewayHost: string,
  gatewayPort: number,
  targetUrl: string,
  creds?: Creds
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const req = http.request(
      {
        host: gatewayHost,
        port: gatewayPort,
        method: "GET",
        path: targetUrl,
        headers: {
          Host: url.host,
          ...(creds ? { "Proxy-Authorization": proxyAuthHeader(creds) } : {}),
          Connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export function connectRaw(
  host: string,
  port: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

export { parseHostPort };