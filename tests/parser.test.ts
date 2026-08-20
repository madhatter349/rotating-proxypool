import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseSource, dedupeCandidates } from "../src/sources/parser.js";

describe("parser unit", () => {
  it("parses bare ip:port", () => {
    const c = parseLine("1.2.3.4:8080", "src");
    assert.deepEqual(c, { host: "1.2.3.4", port: 8080, protocol: "auto", source: "src" });
  });

  it("parses protocol-prefixed lines", () => {
    assert.equal(parseLine("http://1.2.3.4:3128", "s")?.protocol, "http");
    assert.equal(parseLine("socks5://1.2.3.4:1080", "s")?.protocol, "socks5");
    assert.equal(parseLine("socks4://1.2.3.4:1081", "s")?.protocol, "socks4");
    assert.equal(parseLine("https://1.2.3.4:443", "s")?.protocol, "https");
  });

  it("parses hostname:port", () => {
    const c = parseLine("proxy.example.com:8080", "s");
    assert.equal(c?.host, "proxy.example.com");
    assert.equal(c?.port, 8080);
  });

  it("rejects invalid lines", () => {
    assert.equal(parseLine("", "s"), null);
    assert.equal(parseLine("# comment", "s"), null);
    assert.equal(parseLine("// comment", "s"), null);
    assert.equal(parseLine("notaproxy", "s"), null);
    assert.equal(parseLine("1.2.3.4:99999", "s"), null);
    assert.equal(parseLine("1.2.3.4:0", "s"), null);
    assert.equal(parseLine("999.999.999.999:80", "s"), null);
    assert.equal(parseLine("1.2.3.4:abc", "s"), null);
  });

  it("ignores trailing credentials on bare ip:port", () => {
    const c = parseLine("1.2.3.4:8080:user:pass", "s");
    assert.equal(c?.host, "1.2.3.4");
    assert.equal(c?.port, 8080);
  });

  it("parses multi-format sources and dedupes", () => {
    const raw = [
      "http://1.2.3.4:8080",
      "1.2.3.4:8080",
      "socks5://5.6.7.8:1080",
      "5.6.7.8:1080",
      "garbage line",
      "",
    ].join("\n");
    const { candidates } = parseSource(raw, "src", "all");
    // http://1.2.3.4:8080 and 1.2.3.4:8080 both parse (one http, one auto)
    assert.equal(candidates.length, 4);
    const deduped = dedupeCandidates(candidates);
    // http + auto are distinct keys -> 4 unique
    assert.equal(deduped.length, 4);
  });

  it("parses JSON arrays of ip:port strings and objects", () => {
    const raw = JSON.stringify(["1.2.3.4:8080", { ip: "9.9.9.9", port: 3128, protocol: "socks5" }]);
    const { candidates } = parseSource(raw, "src", "auto");
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.host, "1.2.3.4");
    assert.equal(candidates[1]?.protocol, "socks5");
  });

  it("parses JSON objects with country metadata", () => {
    const raw = JSON.stringify([{ ip: "3.3.3.3", port: 80, protocol: "http", country: "US" }]);
    const { candidates } = parseSource(raw, "src", "http");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.protocol, "http");
  });

  it("dedupe removes exact duplicates", () => {
    const raw = ["1.2.3.4:8080", "1.2.3.4:8080", "http://1.2.3.4:8080"].join("\n");
    const { candidates } = parseSource(raw, "src", "http");
    assert.equal(candidates.length, 2);
  });
});