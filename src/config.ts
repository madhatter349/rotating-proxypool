import { z } from "zod";

const sourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  // Hint for candidate protocol: "http" | "https" | "socks4" | "socks5" | "all" | "auto"
  kind: z
    .enum(["http", "https", "socks4", "socks5", "all", "auto"])
    .default("auto"),
  enabled: z.boolean().default(true),
});

export type SourceConfig = z.infer<typeof sourceSchema>;

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().min(1),

  GATEWAY_USERNAME: z.string().default(""),
  GATEWAY_PASSWORD: z.string().default(""),
  GATEWAY_AUTH_REQUIRED: z.coerce.boolean().default(true),

  ADMIN_TOKEN: z.string().default(""),

  // Publicly visible connection metadata served by /api-meta for the docs site.
  // Never contains credentials. When unset, the gateway's own bound host/port
  // and username are reported instead.
  PUBLIC_PROXY_HOST: z.string().default(""),
  PUBLIC_PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(0),
  PUBLIC_API_URL: z.string().url().default(""),

  VALIDATION_TARGETS: z
    .string()
    .default("https://api.ipify.org,https://httpbin.org/ip"),
  VALIDATION_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(40),
  VALIDATION_TIMEOUT_MS: z.coerce.number().int().min(500).default(8000),
  // Per-source-IP request cap on the public /api/validate endpoint (per minute).
  // Protects the open test endpoint from being DDoS'd while staying usable for
  // manual curl tests and pool validation traffic.
  VALIDATE_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().min(200).default(3000),
  GATEWAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).default(120000),

  // Gateway per-stage timeout budgets (ms).
  // TUNNEL_FIRST_BYTE_TIMEOUT_MS bounds how long we wait after a tunnel is
  // established for the first byte from the origin before abandoning it (the
  // "proxy accepted CONNECT then stopped forwarding" stall). No response bytes
  // have been delivered yet, so tearing down is safe and lets the client retry.
  TUNNEL_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
  // TUNNEL_IDLE_TIMEOUT_MS bounds silence once a response is flowing; a
  // legitimate transfer always has ongoing bytes, so a connection silent this
  // long is effectively dead. Must be well below typical client read timeouts
  // (httpbin's is ~30s) so the gateway observes and penalizes the stall instead
  // of racing the client and losing.
  TUNNEL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(2000).default(8000),

  // After a gateway attempt fails for a proxy, keep it out of rotation for this
  // long so a single flaky upstream cannot immediately be re-selected within a
  // request or across rapid successive requests.
  GATEWAY_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000),
  // Max age of a proxy's last real success before the gateway stops routing to
  // it. Keeps user traffic off stale-healthy rows that validated long ago but
  // have since gone silent; a scheduled recheck that succeeds refreshes it.
  GATEWAY_MAX_LAST_SUCCESS_AGE_MS: z.coerce.number().int().min(30000).default(900000),
  // Proxies whose measured latency exceeds this (ms) are excluded from gateway
  // rotation. Keeps slow/unstable upstreams out of the client path.
  GATEWAY_MAX_LATENCY_MS: z.coerce.number().int().min(500).default(2500),

  // Selection quality (production evidence) tuning.
  // A proxy whose last real gateway success is within this window is "hot" and
  // strongly preferred. Evidence ages beyond this and decays toward the floor.
  HOT_SUCCESS_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  // Full decay horizon for past production success (ms). # After this a proxy
  // with no fresh gateway evidence is treated like a freshly-validated proxy.
  PROD_QUALITY_DECAY_MS: z.coerce.number().int().min(60000).default(1800000),
  // Penalty step per recent gateway failure (fraction of weight removed).
  // A proxy with several recent real failures is de-weighted hard.
  GATEWAY_FAILURE_PENALTY: z.coerce.number().min(0).max(1).default(0.5),
  // Fraction of gateway selections that explore the wider healthy pool (rather
  // than exploit the hot/shortlist). Keeps newly-good proxies discoverable and
  // preserves exit diversity.
  GATEWAY_EXPLORATION_FRACTION: z.coerce.number().min(0).max(1).default(0.05),
  // Minimum gateway attempts on a source before its production success rate may
  // influence selection (avoids dominating from a tiny sample).
  SOURCE_CONFIDENCE_MIN: z.coerce.number().int().min(1).default(8),

  DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(5000).default(3600000),
  VALIDATE_NEW_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  RECHECK_INTERVAL_MS: z.coerce.number().int().min(5000).default(60000),
  QUARANTINE_RETEST_INTERVAL_MS: z.coerce.number().int().min(5000).default(120000),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(10000).default(900000),

  CONSECUTIVE_FAILURES_TO_QUARANTINE: z.coerce.number().int().min(1).default(3),
  QUARANTINE_MS: z.coerce.number().int().min(1000).default(1800000),
  MIN_HEALTHY_SCORE: z.coerce.number().int().min(0).max(100).default(25),
  MAX_STALE_AGE_MS: z.coerce.number().int().min(60000).default(86400000),
  VALIDATION_FAILURES_TO_DEAD: z.coerce.number().int().min(1).default(3),
  VALIDATE_NEW_MAX_BATCH: z.coerce.number().int().min(1).default(3000),
  RECHECK_MAX_BATCH: z.coerce.number().int().min(1).default(400),

  SOURCE_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  SOURCE_MAX_BYTES: z.coerce.number().int().min(1024).default(5242880),
  // Max candidates ingested per source per refresh. Large scraped lists (50k+)
  // are mostly dead; capping keeps the pool from flooding the DB with junk that
  // validation would never reach.
  SOURCE_MAX_CANDIDATES: z.coerce.number().int().min(100).default(2000),

  SOURCES_JSON: z.string().optional(),
  DISCOVERY_ENABLED: z.coerce.boolean().default(true),
});

export type Env = z.infer<typeof envSchema>;

const DEFAULT_SOURCES: SourceConfig[] = [
  { name: "proxifly-http", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt", kind: "http", enabled: true },
  { name: "proxifly-https", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt", kind: "https", enabled: true },
  { name: "proxifly-socks4", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt", kind: "socks4", enabled: true },
  { name: "proxifly-socks5", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt", kind: "socks5", enabled: true },
  { name: "jetkai-online", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies.txt", kind: "auto", enabled: true },
  { name: "iplocate-all", url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt", kind: "auto", enabled: true },
  { name: "vpslab-http", url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/http_all.txt", kind: "http", enabled: true },
  { name: "vpslab-socks4", url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/socks4_all.txt", kind: "socks4", enabled: true },
  { name: "vpslab-socks5", url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/socks5_all.txt", kind: "socks5", enabled: true },
  // Additional verified GitHub proxy-list sources (checked 2026-08-21).
  { name: "monosans-http", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", kind: "http", enabled: true },
  { name: "monosans-socks4", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", kind: "socks4", enabled: true },
  { name: "monosans-socks5", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", kind: "socks5", enabled: true },
  { name: "speedx-http", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", kind: "http", enabled: true },
  { name: "speedx-socks4", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", kind: "socks4", enabled: true },
  { name: "speedx-socks5", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", kind: "socks5", enabled: true },
  { name: "clarketm-http", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", kind: "http", enabled: true },
  { name: "shiftytr-http", url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt", kind: "http", enabled: true },
  { name: "proxy4parsing-http", url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt", kind: "http", enabled: true },
  { name: "ercindedeoglu-http", url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", kind: "http", enabled: true },
  { name: "roosterkid-https", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", kind: "https", enabled: true },
  { name: "roosterkid-socks4", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt", kind: "socks4", enabled: true },
  { name: "roosterkid-socks5", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt", kind: "socks5", enabled: true },
  { name: "vakhov-http", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", kind: "http", enabled: true },
  { name: "vakhov-socks4", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", kind: "socks4", enabled: true },
  { name: "vakhov-socks5", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", kind: "socks5", enabled: true },
  { name: "zevtyardt-http", url: "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt", kind: "http", enabled: true },
  { name: "aliilapro-http", url: "https://raw.githubusercontent.com/ALIILAPRO/proxy/main/http.txt", kind: "http", enabled: true },
  { name: "sunny-proxies", url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt", kind: "auto", enabled: true },
];

export interface AppConfig {
  env: Env;
  sources: SourceConfig[];
  validationTargets: string[];
}

function parseSources(env: Env): SourceConfig[] {
  if (!env.SOURCES_JSON) return DEFAULT_SOURCES;
  try {
    const parsed = JSON.parse(env.SOURCES_JSON);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return z.array(sourceSchema).parse(arr);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to parse SOURCES_JSON, falling back to defaults:", err);
    return DEFAULT_SOURCES;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const sources = parseSources(parsed);
  const validationTargets = parsed.VALIDATION_TARGETS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith("http") ? s : `https://${s}`));
  return { env: parsed, sources, validationTargets };
}

export function gatewayAuthConfigured(cfg: AppConfig): boolean {
  return cfg.env.GATEWAY_USERNAME.length > 0 && cfg.env.GATEWAY_PASSWORD.length > 0;
}

export function adminAuthConfigured(cfg: AppConfig): boolean {
  return cfg.env.ADMIN_TOKEN.length > 0;
}