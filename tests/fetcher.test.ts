import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchSource, SourceFetchError } from "../src/sources/fetcher.js";
import { withTimeout } from "./helpers/testEnv.js";

describe("source fetcher", () => {
  let server: http.Server;
  let base: string;
  const teardown: Array<() => Promise<void>> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("1.2.3.4:8080\n5.6.7.8:1080\n");
      } else if (req.url === "/missing") {
        res.writeHead(404);
        res.end("nope");
      } else if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end("late");
        }, 3000);
      } else if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(100000));
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    teardown.push(() => new Promise<void>((r) => server.close(() => r())));
  });

  after(async () => {
    for (const fn of teardown) await fn();
  });

  it("fetches a successful source", async () => {
    const res = await fetchSource(`${base}/ok`, { timeoutMs: 5000, maxBytes: 1_000_000 });
    assert.equal(res.httpStatus, 200);
    assert.ok(res.text.includes("1.2.3.4:8080"));
  });

  it("rejects non-2xx responses", async () => {
    await assert.rejects(
      fetchSource(`${base}/missing`, { timeoutMs: 5000, maxBytes: 1_000_000 }),
      (err: Error) => err instanceof SourceFetchError && /404/.test(err.message)
    );
  });

  it("rejects slow sources that exceed the timeout", async () => {
    await assert.rejects(
      fetchSource(`${base}/slow`, { timeoutMs: 500, maxBytes: 1_000_000 }),
      (err: Error) => err instanceof SourceFetchError && /timeout/i.test(err.message)
    );
  });

  it("rejects oversized bodies", async () => {
    await assert.rejects(
      fetchSource(`${base}/big`, { timeoutMs: 5000, maxBytes: 1000 }),
      (err: Error) => err instanceof SourceFetchError && /exceeds/i.test(err.message)
    );
  });

  it("works with a timeout race guard", async () => {
    const res = await withTimeout(
      fetchSource(`${base}/ok`, { timeoutMs: 5000, maxBytes: 1_000_000 }),
      10000
    );
    assert.equal(res.httpStatus, 200);
  });
});