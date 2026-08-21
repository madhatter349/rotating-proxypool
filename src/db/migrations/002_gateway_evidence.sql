-- 002_gateway_evidence.sql
-- Persist gateway production evidence and metrics so a restart does not wipe
-- the selection-quality data and dashboard telemetry.

CREATE TABLE IF NOT EXISTS gateway_evidence (
  proxy_id BIGINT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_success_at BIGINT,
  recent_failures INTEGER NOT NULL DEFAULT 0,
  recent_latencies_ms JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  connections BIGINT NOT NULL DEFAULT 0,
  connect_requests BIGINT NOT NULL DEFAULT 0,
  http_requests BIGINT NOT NULL DEFAULT 0,
  auth_failures BIGINT NOT NULL DEFAULT 0,
  upstream_failures BIGINT NOT NULL DEFAULT 0,
  retries BIGINT NOT NULL DEFAULT 0,
  tunnel_established BIGINT NOT NULL DEFAULT 0,
  success BIGINT NOT NULL DEFAULT 0,
  early_close BIGINT NOT NULL DEFAULT 0,
  total_client_requests BIGINT NOT NULL DEFAULT 0,
  first_attempt_success BIGINT NOT NULL DEFAULT 0,
  retry_recovered BIGINT NOT NULL DEFAULT 0,
  retry_exhausted BIGINT NOT NULL DEFAULT 0,
  timeouts BIGINT NOT NULL DEFAULT 0,
  request_durations_ms JSONB NOT NULL DEFAULT '[]'::jsonb,
  requests_by_protocol JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gateway_metrics (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
