# AGENTS.md

Guidance for AI agents working in this repository.

## Project overview

A production rotating proxy pool service. It continuously discovers public HTTP/SOCKS
proxies from free lists, validates them against HTTPS targets with real traffic,
scores and ranks them, and exposes an authenticated forward proxy gateway that
rotates across the healthy pool (with retries and failure-based lifecycle).

- Runtime: Node.js 22+ (ESM, TypeScript). Server: Fastify (API/dashboard) + raw
  `net` sockets (proxy gateway). Persistence: PostgreSQL.
- Tests: built-in `node:test` runner driven through `tsx`.

## Commands

Always run these before considering a change done:

```bash
npm run typecheck   # tsc --noEmit on both tsconfig.json and tsconfig.test.json
npm run lint        # eslint . --max-warnings 0
npm test            # node --import tsx --test "tests/**/*.test.ts"
npm run build       # tsc -p tsconfig.json (emits dist/)
```

`npm test` must finish with exit code 0. The suite must NOT leave the process
running: every mock server, gateway, and socket opened by a test must be closed in
`teardown`, otherwise the run hangs. When adding tests, verify with
`node --import tsx --test tests/<file>.test.ts` first, then run the whole suite.

## Architecture map

- `src/config.ts` — zod env schema, default sources, `loadConfig()`.
- `src/types.ts` — shared domain types (ProxyRecord, statuses, validation results).
- `src/db/` — pg pool singleton, migration runner, `Repository`, `migrations/001_init.sql`.
- `src/sources/` — `parser.ts` (list parsing), `fetcher.ts` (bounded fetch),
  `registry.ts` (source rows + refresh orchestration).
- `src/validate/` — `connect.ts` (CONNECT/SOCKS handshakes + TLS-over-tunnel with
  strict timeouts), `validator.ts` (validates a proxy with real HTTPS traffic;
  `tlsCa` option exists so tests can trust the mock cert).
- `src/pool/` — `scoring.ts` (0..100 score), `lifecycle.ts` (state transitions),
  `rotator.ts` (weighted-random selection), `manager.ts` (orchestration + PoolRepo interface).
- `src/gateway/` — `upstream.ts` (tunneling/forwarding to upstream proxies),
  `server.ts` (auth, CONNECT, absolute-URI plain HTTP, private-IP blocking, retries).
- `src/api/server.ts` — Fastify admin API + `/health`, `/ready`, `/stats`, dashboard.
- `src/scheduler/scheduler.ts` — periodic discovery/validation/recheck/retest/cleanup.
- `src/index.ts` — composition root.

## Key invariants to preserve

- **Fail closed on auth**: the gateway rejects with 407 whenever credentials are
  missing/empty (server.ts `checkAuth`). Admin API rejects without `ADMIN_TOKEN`.
- **Bounded work**: every network operation has a timeout; validation concurrency is
  capped; source fetches cap bytes; no unbounded promises/queues.
- **Protocol handshakes consume the full reply**: `httpConnect`, `socks5Connect`,
  `socks4Connect` buffer until the entire proxy reply has been read, so reply bytes
  can never leak into the subsequent TLS stream (this was a real bug).
- **No servername for IP literals**: `tls.connect` rejects `servername` set to an IP.
  Use `net.isIP(host) ? {} : { servername: host }`.
- **No secrets in the repo**: env-driven credentials only. `.env` files are ignored.
- **Lifecycle counters**: repos increment `consecutive_failures`/`failure_count`
  BEFORE `decideAfterFailure` is called; the decision function must NOT add +1 again
  (double-counting was a real bug).

## Test conventions

- `tests/mocks/proxies.ts` — mock HTTP/SOCKS4/SOCKS5 proxies, HTTPS/HTTP echo targets,
  and closed-port helper. Mocks must remove their `data` listener once a tunnel is
  established so tunneled bytes are never re-parsed.
- `tests/mocks/cert.ts` — self-signed cert/key for mock HTTPS targets (SAN IP:127.0.0.1).
- `tests/helpers/` — `fakeRepo.ts` (in-memory repository), `client.ts` (client helpers),
  `testEnv.ts` (`makeConfig` with short timeouts and thresholds).
- Validators used against the mock HTTPS echo target must pass `{ tlsCa: MOCK_CERT }`.
- Mock-suite tests must ensure every socket is destroyed so the process can exit.