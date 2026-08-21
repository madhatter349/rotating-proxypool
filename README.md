# Rotating Proxy Pool

A self-hosted rotating proxy gateway. It continuously discovers public HTTP/SOCKS
proxies, validates them with real HTTPS traffic, scores the healthy ones, and serves
clients through a single authenticated endpoint that rotates upstreams and retries
failed attempts.

## Highlights

- **Discover**: 9 free proxy sources (proxifly, jetkai, iplocate, VPSLab) refreshed on a schedule.
- **Validate**: real HTTPS GET through each candidate (CONNECT tunneling / SOCKS handshakes)
  with bounded concurrency and strict timeouts. Auto candidates detect their working protocol.
- **Score**: 0–100 reliability score (success rate, latency, freshness, stability).
- **Lifecycle**: healthy → degraded → quarantined → retest → healthy | dead; stale rows cleaned up.
- **Gateway**: authenticated forward proxy (HTTP + HTTPS via CONNECT) with weighted-random
  rotation, retries, private-IP blocking, and fail-closed auth. The gateway tunnels through
  both HTTP **and SOCKS** healthy upstreams (protocol-matched handshake), so the whole pool
  is usable.
- **Ops**: `/health`, `/ready`, `/stats`, admin API, and a live dashboard.

## Architecture

See [PLAN.md](PLAN.md). Layout:

```
src/
  config.ts          env schema (zod) + default sources
  types.ts           domain types
  db/                pg pool, migrations, repository
  sources/           parsers, fetcher, source registry
  validate/          proxy handshakes + real-traffic validation
  pool/              scoring, lifecycle, rotation, manager
  gateway/           upstream tunneling + auth server
  api/               Fastify admin API + dashboard
  scheduler/         periodic jobs
  index.ts           entrypoint
tests/               node:test suites + mocks + helpers
```

## Prerequisites

- Node.js 22+ and npm
- PostgreSQL (local or `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres`)
- (Deployment) a Railway account and GitHub repo

## Quick start

```bash
npm install
cp .env.example .env        # set DATABASE_URL, GATEWAY_USERNAME/PASSWORD, ADMIN_TOKEN
npm run build
npm start                   # migrates the DB, then starts gateway + API + scheduler
```

The gateway listens on `PROXY_PORT` (default 8081), the API/dashboard on `PORT`
(default 8080).

## Using the proxy

```bash
# HTTPS through the gateway
curl -x http://proxyuser:change-me-strong-password@127.0.0.1:8081 https://api.ipify.org

# Plain HTTP (absolute-URI form)
curl -x http://proxyuser:change-me-strong-password@127.0.0.1:8081 http://httpbin.org/ip

# In code (Node): pass the URL to an http(s).request proxy option or use
# https-proxy-agent / socks-proxy-agent against the gateway.
```

`Proxy-Authorization: Basic ...` is required on every request (fail-closed; 407
otherwise). Credentials are never forwarded to upstream proxies.

### Auto-rotate until valid

Each request exits through a **different** proxy (per-request weighted rotation).
The gateway already retries unreachable/stalled upstreams itself; for a site
that rejects a given exit IP (403/5xx) or a tunnel that dies mid-handshake,
simply retry the request client-side - every attempt uses a fresh IP:

```python
import requests, time
PROXY  = "http://user:pass@altaria.proxy.rlwy.net:51121"
PROXIES = {"http": PROXY, "https": PROXY}
for attempt in range(1, 6):
    try:
        r = requests.get("https://example.com/endpoint", proxies=PROXIES, timeout=30)
        if r.status_code < 400:
            print("OK", r.status_code); break
        print(f"attempt {attempt}: {r.status_code}, retrying...")
    except requests.RequestException as e:
        print(f"attempt {attempt}: {e!r}, retrying...")
    time.sleep(0.5)
else:
    raise SystemExit("all attempts failed")
```

Why not rotate on the backend? HTTPS is tunneled end-to-end (opaque to the
gateway), so the gateway cannot read a 403 from the origin without MITM-ing the
client - which it deliberately does not do.

## Configuration

All settings are environment variables (see `.env.example`). Notable ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `PROXY_PORT` | 8080 / 8081 | API/dashboard vs raw proxy gateway |
| `GATEWAY_USERNAME` / `GATEWAY_PASSWORD` | empty | proxy auth (must be set) |
| `ADMIN_TOKEN` | empty | Bearer token for `/api/*` |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `VALIDATION_TARGETS` | api.ipify.org,httpbin.org/ip | HTTPS targets for validation |
| `VALIDATION_CONCURRENCY` | 40 | bounded validation parallelism |
| `SOURCES_JSON` | — | JSON array to override source lists |

## Admin API

`GET /stats` — pool/source/gateway stats. All other `/api/*` routes require
`Authorization: Bearer $ADMIN_TOKEN`: `GET /api/proxies`, `GET /api/proxies/active`,
`GET /api/sources`, `POST /api/refresh`, `POST /api/check`.

## Development

```bash
npm run dev        # tsx watch
npm run typecheck  # tsc --noEmit (both tsconfigs)
npm run lint       # eslint --max-warnings 0
npm test           # node:test via tsx (69 tests)
```

## Deploying to Railway

1. Push the repo to GitHub (CI runs lint + typecheck + tests + docker build).
2. Create a Railway project and add a PostgreSQL service.
3. Add a service from the GitHub repo (Dockerfile builder).
4. Set env vars: `DATABASE_URL` (reference `${{Postgres.DATABASE_URL}}`),
   `GATEWAY_USERNAME`, `GATEWAY_PASSWORD`, `ADMIN_TOKEN`, `PORT=8080`, `PROXY_PORT=8081`.
5. Expose the API/dashboard with a Railway public domain (HTTP).
6. Expose the raw proxy gateway with a TCP proxy: `railway tcp-proxy create --port 8081 --service <service>`.

## Security notes

- Proxy and admin credentials are required; the gateway rejects when unset.
- Production blocks CONNECT to private/loopback addresses.
- No secrets in the repository; all credentials come from the environment.