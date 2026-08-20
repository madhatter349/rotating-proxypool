# PLAN.md

Implementation plan and architecture for the rotating proxy pool.

## Goal

Expose a single authenticated forward proxy endpoint backed by a continuously
refreshed pool of public HTTP/SOCKS proxies. Clients point their HTTP(S) traffic at
our gateway; the gateway authenticates, selects a healthy upstream, tunnels the
request, retries on failure, and learns which upstreams are dead over time.

## Architecture

```
discovery (sources) -> candidates -> validation (real HTTPS traffic) -> pool (scored)
        scheduler                                     ^                        |
        (periodic)                                    +--- recheck / retest <----+
                                                        (quarantine / dead)
                                        |
                                   gateway (auth + rotate + retry)  -> client
```

- **Sources**: 9 default free proxy lists (proxifly, jetkai, iplocate, VPSLab).
  Fetch bounded (20s timeout, 5MB cap), parse `host:port[:protocol]` lines,
  dedupe by (host, port, protocol), upsert as `pending` candidates.
- **Validation**: real HTTPS GET through the proxy (CONNECT tunnel for HTTP,
  SOCKS5/SOCKS4 handshakes otherwise) to targets like `https://api.ipify.org`.
  Auto/probe candidates try http → socks5 → socks4 and record the working protocol
  as a separate row. Concurrency capped (`VALIDATION_CONCURRENCY`).
- **Scoring** (0..100): `0.4 * successRate + 0.25 * latency + 0.2 * freshness +
  0.15 * stability`. `MIN_HEALTHY_SCORE` gates gateway eligibility.
- **Lifecycle**: `discovered/pending → healthy → degraded → quarantined → retest →
  healthy | dead`. Quarantine after `CONSECUTIVE_FAILURES_TO_QUARANTINE` consecutive
  failures; pending candidates die after `VALIDATION_FAILURES_TO_DEAD` validation
  failures; stale undiscovered rows are cleaned up.
- **Gateway**: raw TCP server on `PROXY_PORT`. Requires `Proxy-Authorization: Basic`
  (407 otherwise, fail-closed). Supports `CONNECT` (HTTPS) and absolute-URI plain
  HTTP. Blocks private/loopback targets (configurable). Picks a weighted-random
  upstream per request, retries up to `maxRetries`, tracks success/failure stats.
- **API** (Fastify on `PORT`): `GET /health`, `GET /ready`, `GET /stats`,
  admin-protected endpoints (Bearer `ADMIN_TOKEN`), and a dashboard at `/`.
- **Scheduler**: periodic discovery, new-candidate validation, healthy recheck,
  quarantine retest, stale cleanup.

## Database

PostgreSQL with a single migration (`src/db/migrations/001_init.sql`):

- `proxies`: identity (host, port, protocol) unique, counters, latency, score,
  status, timestamps, `probe` flag, `supports_https`, `exit_ip`.
- `sources`: configured list URLs with last fetch state/counts.
- `schema_migrations`: applied migration tracking.

## Deployment

- Docker multi-stage build (`node:22-alpine`), healthcheck on `/health`.
- Railway: one service from the GitHub repo; Postgres plugin provides
  `DATABASE_URL`. HTTP domain → API/dashboard; TCP proxy (`railway tcp-proxy`)
  → the raw proxy gateway.
- Environment: `DATABASE_URL`, `GATEWAY_USERNAME`, `GATEWAY_PASSWORD`,
  `ADMIN_TOKEN`, `PORT`, `PROXY_PORT` (see `.env.example`).

## Deliberate trade-offs

- Public free proxies are unreliable: expect high churn and keep validation strict.
- No sticky sessions / no per-client upstream affinity; rotation is per-request.
- `blockPrivate: true` is the production default (SSRF / loop protection); it is
  disabled in tests to exercise tunneling to 127.0.0.1 mock targets.

## Status

- [x] Core implementation (sources, validation, scoring, lifecycle, gateway, API, scheduler)
- [x] Test suite (66 tests: parser, scoring, lifecycle, rotator, config, fetcher,
      validator, gateway, manager) — all green
- [x] Lint / typecheck / build green
- [ ] Docs (this file, README, AGENTS)
- [ ] Dockerfile, railway.toml, GitHub Actions CI
- [ ] Push to GitHub
- [ ] Deploy to Railway + Postgres + domains/TCP proxy
- [ ] Verify production endpoints and rotation