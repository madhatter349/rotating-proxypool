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

  VALIDATION_TARGETS: z
    .string()
    .default("https://api.ipify.org,https://httpbin.org/ip"),
  VALIDATION_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(40),
  VALIDATION_TIMEOUT_MS: z.coerce.number().int().min(500).default(10000),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().min(200).default(5000),

  // Gateway per-stage timeout budgets (ms).
  // TUNNEL_FIRST_BYTE_TIMEOUT_MS bounds how long we wait after a tunnel is
  // established for the first byte from the origin before abandoning it (the
  // "proxy accepted CONNECT then stopped forwarding" stall). No response bytes
  // have been delivered yet, so tearing down is safe and lets the client retry.
  TUNNEL_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(12000),
  // TUNNEL_IDLE_TIMEOUT_MS bounds silence once a response is flowing; a
  // legitimate transfer always has ongoing bytes, so a connection silent this
  // long is effectively dead.
  TUNNEL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(2000).default(30000),

  // After a gateway attempt fails for a proxy, keep it out of rotation for this
  // long so a single flaky upstream cannot immediately be re-selected within a
  // request or across rapid successive requests.
  GATEWAY_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000),

  // Selection quality (production evidence) tuning.
  // A proxy whose last real gateway success is within this window is "hot" and
  // strongly preferred. Evidence ages beyond this and decays toward the floor.
  HOT_SUCCESS_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  // Full decay horizon for past production success (ms). # After this a proxy
  // with no fresh gateway evidence is treated like a freshly-validated proxy.
  PROD_QUALITY_DECAY_MS: z.coerce.number().int().min(60000).default(1800000),
  // Penalty step per recent gateway failure (fraction of weight removed).
  // A proxy with several recent real failures is de-weighted hard.
  GATEWAY_FAILURE_PENALTY: z.coerce.number().min(0).max(1).default(0.5),
  // Fraction of gateway selections that explore the wider healthy pool (rather
  // than exploit the hot/shortlist). Keeps newly-good proxies discoverable and
  // preserves exit diversity.
  GATEWAY_EXPLORATION_FRACTION: z.coerce.number().min(0).max(1).default(0.2),
  // Minimum gateway attempts on a source before its production success rate may
  // influence selection (avoids dominating from a tiny sample).
  SOURCE_CONFIDENCE_MIN: z.coerce.number().int().min(1).default(8),
  // A recent real gateway success slower than this is weak evidence (de-weight).
  SLOW_SUCCESS_THRESHOLD_MS: z.coerce.number().int().min(500).default(3000),
  // A recent real gateway success slower than this is very weak evidence
  // (stronger de-weight and a short selection cooldown).
  VERY_SLOW_SUCCESS_THRESHOLD_MS: z.coerce.number().int().min(1000).default(6000),
  // How long a very-slow successful proxy stays out of rotation.
  SLOW_SUCCESS_COOLDOWN_MS: z.coerce.number().int().min(0).default(30000),

  DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(5000).default(300000),
  VALIDATE_NEW_INTERVAL_MS: z.coerce.number().int().min(5000).default(60000),
  RECHECK_INTERVAL_MS: z.coerce.number().int().min(5000).default(180000),
  QUARANTINE_RETEST_INTERVAL_MS: z.coerce.number().int().min(5000).default(120000),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(10000).default(900000),

  CONSECUTIVE_FAILURES_TO_QUARANTINE: z.coerce.number().int().min(1).default(3),
  QUARANTINE_MS: z.coerce.number().int().min(1000).default(1800000),
  MIN_HEALTHY_SCORE: z.coerce.number().int().min(0).max(100).default(25),
  MAX_STALE_AGE_MS: z.coerce.number().int().min(60000).default(86400000),
  VALIDATION_FAILURES_TO_DEAD: z.coerce.number().int().min(1).default(3),
  VALIDATE_NEW_MAX_BATCH: z.coerce.number().int().min(1).default(500),
  RECHECK_MAX_BATCH: z.coerce.number().int().min(1).default(200),

  SOURCE_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  SOURCE_MAX_BYTES: z.coerce.number().int().min(1024).default(5242880),

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