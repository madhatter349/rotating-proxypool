-- 001_init.sql
-- Core schema for rotating-proxypool.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proxies (
  id BIGSERIAL PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https', 'socks4', 'socks5')),
  source TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked TIMESTAMPTZ,
  last_success TIMESTAMPTZ,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_ip TEXT,
  country TEXT,
  supports_https BOOLEAN NOT NULL DEFAULT false,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'pending', 'healthy', 'degraded', 'quarantined', 'dead')),
  quarantined_until TIMESTAMPTZ,
  last_error TEXT,
  probe BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (host, port, protocol)
);

CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies (status);
CREATE INDEX IF NOT EXISTS idx_proxies_score ON proxies (score DESC);
CREATE INDEX IF NOT EXISTS idx_proxies_source ON proxies (source);
CREATE INDEX IF NOT EXISTS idx_proxies_last_checked ON proxies (last_checked);

CREATE TABLE IF NOT EXISTS sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'auto',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_fetched TIMESTAMPTZ,
  last_success TIMESTAMPTZ,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  unique_candidates INTEGER NOT NULL DEFAULT 0,
  working INTEGER NOT NULL DEFAULT 0,
  validation_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);