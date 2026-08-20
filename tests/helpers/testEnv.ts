import { loadConfig, type AppConfig } from "../../src/config.js";

/**
 * Build a config with test-friendly overrides. Copies process.env so the
 * defaults apply, then applies overrides on top.
 */
export function makeConfig(
  overrides: Record<string, string> = {}
): AppConfig {
  const env = { ...process.env };
  const defaults: Record<string, string> = {
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    GATEWAY_AUTH_REQUIRED: "true",
    GATEWAY_USERNAME: "testuser",
    GATEWAY_PASSWORD: "testpass",
    ADMIN_TOKEN: "test-admin-token",
    VALIDATION_CONCURRENCY: "20",
    VALIDATION_TIMEOUT_MS: "3000",
    CONNECT_TIMEOUT_MS: "2000",
    CONSECUTIVE_FAILURES_TO_QUARANTINE: "2",
    QUARANTINE_MS: "60000",
    VALIDATION_FAILURES_TO_DEAD: "2",
    VALIDATE_NEW_MAX_BATCH: "50",
    RECHECK_MAX_BATCH: "50",
    DISCOVERY_INTERVAL_MS: "600000",
    VALIDATE_NEW_INTERVAL_MS: "600000",
    RECHECK_INTERVAL_MS: "600000",
    QUARANTINE_RETEST_INTERVAL_MS: "600000",
    CLEANUP_INTERVAL_MS: "600000",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (env[k] === undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return loadConfig(env);
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}