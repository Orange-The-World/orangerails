-- ============================================================
-- Temporary table to capture raw inbound Quiltt webhook requests so
-- we can diagnose why Quiltt's signature verification is failing in
-- prod (Quiltt dashboard shows 401 on every delivery; Path B synthetic
-- test with the same secret passes).
--
-- Drop the table + revert or-quiltt-webhook patch in a follow-up PR
-- once we know the actual Quiltt header/signature format.
-- ============================================================

CREATE TABLE IF NOT EXISTS public._quiltt_webhook_debug (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  headers       JSONB NOT NULL,
  body_text     TEXT,
  sig_header    TEXT,
  ts_header     TEXT,
  expected_sig  TEXT,
  secret_prefix TEXT,
  sig_match     BOOLEAN,
  body_length   INTEGER
);

ALTER TABLE public._quiltt_webhook_debug ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

COMMENT ON TABLE public._quiltt_webhook_debug IS
  'TEMP — Quiltt webhook diagnostic capture. Service-role only. Drop after Quiltt signature spec is verified (target removal: next session).';
