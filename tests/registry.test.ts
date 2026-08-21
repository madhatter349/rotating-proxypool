import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SourceRegistry } from "../src/sources/registry.js";
import { FakeRepository } from "./helpers/fakeRepo.js";
import { makeConfig } from "./helpers/testEnv.js";

describe("source registry", () => {
  it("resurrects a dead proxy back to pending when rediscovered", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("203.0.113.10:3128\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const repo = new FakeRepository();
    // Simulate a proxy that was validated once, later died, and is still dead.
    const dead = await repo.insert({
      host: "203.0.113.10",
      port: 3128,
      protocol: "http",
      source: "s1",
      first_seen: new Date(),
      last_seen: new Date(Date.now() - 60_000),
      last_checked: new Date(Date.now() - 60_000),
      last_success: null,
      success_count: 1,
      failure_count: 5,
      consecutive_failures: 5,
      latency_ms: 300,
      success_rate: 0.2,
      exit_ip: null,
      country: null,
      supports_https: true,
      score: 0,
      status: "dead",
      quarantined_until: null,
      last_error: "validation failures exceeded",
      probe: false,
    });
    await repo.ensureSource("s1", `${base}/list.txt`, "http");

    const cfg = makeConfig({ SOURCE_FETCH_TIMEOUT_MS: "5000" });
    const registry = new SourceRegistry(repo, cfg);
    const res = await registry.refreshOne("s1", "http");

    assert.equal(res.ok, true);
    assert.ok(res.unique >= 1, "the rediscovered proxy should be upserted again");
    const after = await repo.getProxy(dead.id);
    assert.ok(after, "proxy row still exists");
    assert.equal(after!.status, "pending", "dead proxy must flip back to pending");

    await new Promise<void>((r) => server.close(() => r()));
  });
});
