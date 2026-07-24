-- Source-of-truth for orbi_api_keys + orbi_usage_log. Created in the dev
-- dashboard with no committed migration; this reproduces live dev schema.
-- Idempotent: IF NOT EXISTS guards make re-running a no-op on dev.
-- Forward-only: down = DROP TABLE which destroys key material and usage
-- history; rollback is restore-from-backup (documented in runbook).
BEGIN;

CREATE TABLE IF NOT EXISTS public.orbi_api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  consumer_id text NOT NULL,
  consumer_name text NOT NULL,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT orbi_api_keys_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS orbi_api_keys_key_hash_uk
  ON public.orbi_api_keys (key_hash);

CREATE INDEX IF NOT EXISTS orbi_api_keys_consumer_idx
  ON public.orbi_api_keys (consumer_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.orbi_usage_log (
  id bigint GENERATED ALWAYS AS IDENTITY,
  consumer_id text NOT NULL,
  key_prefix text NOT NULL,
  asset text NOT NULL,
  fiat text NOT NULL,
  requested_at timestamptz,
  served_at timestamptz NOT NULL DEFAULT now(),
  fill_type text NOT NULL,
  batch_size integer NOT NULL,
  http_status integer NOT NULL,
  CONSTRAINT orbi_usage_log_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS orbi_usage_log_consumer_served_idx
  ON public.orbi_usage_log (consumer_id, served_at DESC);

-- RLS on with zero policies: hard-deny for anon and authenticated,
-- service_role bypasses. Correct posture for key material.
-- orbi_api_keys stores key_hash only (not plaintext key).
ALTER TABLE public.orbi_api_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orbi_usage_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.orbi_api_keys  FROM anon, authenticated;
REVOKE ALL ON public.orbi_usage_log FROM anon, authenticated;

COMMIT;
