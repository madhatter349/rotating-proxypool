export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

export type ProxyStatus =
  | "discovered"
  | "pending"
  | "healthy"
  | "degraded"
  | "quarantined"
  | "dead";

export interface ProxyRecord {
  id: number;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  source: string;
  first_seen: Date;
  last_seen: Date;
  last_checked: Date | null;
  last_success: Date | null;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  latency_ms: number | null;
  success_rate: number;
  exit_ip: string | null;
  country: string | null;
  supports_https: boolean;
  score: number;
  status: ProxyStatus;
  quarantined_until: Date | null;
  last_error: string | null;
  probe: boolean;
}

export interface ProxyCandidate {
  host: string;
  port: number;
  protocol: ProxyProtocol | "auto";
  source: string;
}

export interface SourceRecord {
  id: number;
  name: string;
  url: string;
  kind: string;
  enabled: boolean;
  last_fetched: Date | null;
  last_success: Date | null;
  fetch_count: number;
  candidates: number;
  unique_candidates: number;
  working: number;
  validation_rate: number;
  error_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ValidationResult {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  supportsHttps: boolean;
  error: string | null;
  protocol: ProxyProtocol | null;
}

export type ValidationPhase =
  | "connect"
  | "http-handshake"
  | "socks-handshake"
  | "tls"
  | "request"
  | "response";