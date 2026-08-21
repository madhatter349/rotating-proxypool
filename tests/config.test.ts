import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, gatewayAuthConfigured, adminAuthConfigured } from "../src/config.js";

describe("config", () => {
  it("uses defaults when nothing is set", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x" });
    assert.equal(cfg.env.PORT, 8080);
    assert.equal(cfg.env.PROXY_PORT, 8081);
    assert.equal(cfg.env.TUNNEL_IDLE_TIMEOUT_MS, 8000);
    assert.ok(cfg.validationTargets.length >= 2);
    // Sources: 9 original + 19 added GitHub lists.
    assert.ok(cfg.sources.length >= 25);
    assert.equal(cfg.sources[0]?.kind, "http");
    // Discovery pipeline runs hourly by default.
    assert.equal(cfg.env.DISCOVERY_INTERVAL_MS, 3_600_000);
    // Slow proxies are excluded from gateway rotation by default.
    assert.equal(cfg.env.GATEWAY_MAX_LATENCY_MS, 2500);
    // Validation drains the backlog at a healthy clip.
    assert.equal(cfg.env.VALIDATE_NEW_MAX_BATCH, 3000);
    // Per-source ingestion is capped so 50k-line lists can't flood the DB.
    assert.equal(cfg.env.SOURCE_MAX_CANDIDATES, 2000);
  });

  it("parses numeric env values", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      PORT: "9999",
      VALIDATION_CONCURRENCY: "7",
      CONNECT_TIMEOUT_MS: "1234",
    });
    assert.equal(cfg.env.PORT, 9999);
    assert.equal(cfg.env.VALIDATION_CONCURRENCY, 7);
    assert.equal(cfg.env.CONNECT_TIMEOUT_MS, 1234);
  });

  it("parses validation targets and adds https scheme", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      VALIDATION_TARGETS: "https://a.com, http://b.com, ipify.org",
    });
    assert.equal(cfg.validationTargets[0], "https://a.com");
    assert.equal(cfg.validationTargets[1], "http://b.com");
    assert.equal(cfg.validationTargets[2], "https://ipify.org");
  });

  it("loads custom sources from SOURCES_JSON", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      SOURCES_JSON: JSON.stringify([
        { name: "custom", url: "https://example.com/list.txt", kind: "socks5" },
      ]),
    });
    assert.equal(cfg.sources.length, 1);
    assert.equal(cfg.sources[0]?.kind, "socks5");
  });

  it("falls back to defaults on invalid SOURCES_JSON", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      SOURCES_JSON: "{not json",
    });
    assert.ok(cfg.sources.length >= 9);
  });

  it("auth is configured only when credentials are present", () => {
    const yes = loadConfig({
      DATABASE_URL: "postgres://x",
      GATEWAY_USERNAME: "u",
      GATEWAY_PASSWORD: "p",
      ADMIN_TOKEN: "t",
    });
    assert.equal(gatewayAuthConfigured(yes), true);
    assert.equal(adminAuthConfigured(yes), true);

    const no = loadConfig({ DATABASE_URL: "postgres://x" });
    assert.equal(gatewayAuthConfigured(no), false);
    assert.equal(adminAuthConfigured(no), false);
  });
});
