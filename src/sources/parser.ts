import type { ProxyCandidate, ProxyProtocol } from "../types.js";

const PROTO_RE = /^(socks5|socks4|https|http):\/\/([^:/\s]+):(\d{1,5})\s*$/i;
const BARE_RE = /^([^:/\s]+):(\d{1,5})(?::[^:\s]+){0,2}\s*$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function validHost(host: string): boolean {
  if (host.length > 253) return false;
  if (IPV4_RE.test(host)) {
    return host.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Parse a single candidate string into a ProxyCandidate, or null if invalid.
 * Accepts "ip:port", "protocol://ip:port", "ip:port:user:pass" (ignores creds).
 */
export function parseLine(line: string, source: string): ProxyCandidate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

  const protoMatch = PROTO_RE.exec(trimmed);
  if (protoMatch) {
    const protocol = protoMatch[1]!.toLowerCase() as ProxyProtocol;
    const host = protoMatch[2]!;
    const port = Number(protoMatch[3]!);
    if (!validHost(host) || !validPort(port)) return null;
    return { host, port, protocol, source };
  }

  // Bare ip:port, optionally followed by credentials
  const bareMatch = BARE_RE.exec(trimmed);
  if (bareMatch) {
    const host = bareMatch[1]!;
    const port = Number(bareMatch[2]!);
    if (!validHost(host) || !validPort(port)) return null;
    return { host, port, protocol: "auto", source };
  }

  return null;
}

export interface ParsedSource {
  candidates: ProxyCandidate[];
}

/**
 * Parse raw source content (text or JSON) into candidates.
 * Handles plain text, protocol-prefixed lines, and JSON arrays of
 * {"ip"|"host", "port"} or "ip:port" strings.
 */
export function parseSource(
  raw: string,
  source: string,
  kind: string
): ParsedSource {
  const trimmed = raw.trim();
  const candidates: ProxyCandidate[] = [];
  if (!trimmed) return { candidates };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const arr = Array.isArray(json) ? json : [json];
      for (const item of arr) {
        const cand = parseJsonItem(item, source, kind);
        if (cand) candidates.push(cand);
      }
      return { candidates };
    } catch {
      // fall through to line parsing
    }
  }

  const seen = new Set<string>();
  for (const line of trimmed.split(/\r?\n/)) {
    const cand = parseLine(line, source);
    if (!cand) continue;
    const key = `${cand.protocol}:${cand.host}:${cand.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(cand);
  }

  return { candidates };
}

function parseJsonItem(
  item: unknown,
  source: string,
  kind: string
): ProxyCandidate | null {
  if (typeof item === "string") return parseLine(item, source);
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const host = (obj.ip ?? obj.host ?? obj.address) as string | undefined;
    const port = Number(obj.port);
    const proto = (obj.protocol ?? obj.type) as string | undefined;
    let protocol: ProxyCandidate["protocol"];
    if (typeof proto === "string" && /^(http|https|socks4|socks5)$/i.test(proto)) {
      protocol = proto.toLowerCase() as ProxyProtocol;
    } else if (kind === "http" || kind === "https" || kind === "socks4" || kind === "socks5") {
      protocol = kind;
    } else {
      protocol = "auto";
    }
    if (!host || !validHost(host) || !validPort(port)) return null;
    return { host, port, protocol, source };
  }
  return null;
}

/**
 * Deduplicate candidates across a batch by (protocol, host, port).
 * Auto-detected candidates keep "auto" protocol — dedupe by (auto, host, port).
 */
export function dedupeCandidates(candidates: ProxyCandidate[]): ProxyCandidate[] {
  const seen = new Set<string>();
  const out: ProxyCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.protocol}:${c.host}:${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}