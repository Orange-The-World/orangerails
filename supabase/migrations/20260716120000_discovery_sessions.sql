-- ============================================================
-- discovery_sessions: server-side map from a discovered wallet's opaque
-- id to the provider's real per-account key, for the widget connect flow.
-- ============================================================
-- Why this table exists:
--
-- The /connect widget calls or-discover-wallets (raw-credentials mode) to
-- list a provider's wallets before the user picks which to connect. The
-- adapter emits an OPAQUE external_wallet_id (a random UUID) per wallet and
-- deliberately does NOT emit the provider's real account key (e.g. a Strike
-- receiverId), because that key is account-identifying and must never reach
-- the browser or the integrator.
--
-- But the write path (or-link-complete) needs the real account key to compute
-- the internal dedup fingerprint (keyed HMAC over subaccount, provider, and
-- the account key + currency). The key cannot travel through the client. So
-- or-discover-wallets records the mapping server-side here, and or-link-complete
-- reads it back by (widget session, external_wallet_id) when the user commits.
--
-- The account_key column is a real account identifier and a self-custody
-- surface. It is server-side ONLY: this migration locks the table to
-- service_role and asserts that no browser-facing role can ever read it, the
-- same shape as the platforms column-grant fix (20260713160000). If a signed-in
-- user could read this map, we would recreate the exact exposure that fix closed.
--
-- Lifetime: rows are tied to a pending_widget_sessions row (the widget token)
-- via ON DELETE CASCADE, so the existing hourly widget-session cleanup removes
-- discovery rows with their parent. Short-lived by construction.
--
-- Properties:
--   Additive:    a fresh table, CREATE TABLE IF NOT EXISTS, no existing row is
--                touched or rewritten.
--   Idempotent:  IF NOT EXISTS on the table and indexes; REVOKE is declarative.
--                Re-running converges and never errors or doubles.
--   Reversible:  DROP TABLE undo written at the bottom (run by hand only).

CREATE TABLE IF NOT EXISTS public.discovery_sessions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_session_id  UUID         NOT NULL REFERENCES public.pending_widget_sessions(id) ON DELETE CASCADE,
  external_wallet_id TEXT         NOT NULL,
  provider_type      TEXT         NOT NULL,
  -- The provider's real per-account key (e.g. a Strike receiverId). Server-side
  -- only: never emitted to any client or API response. Read by or-link-complete
  -- to compute the internal dedup fingerprint.
  account_key        TEXT         NOT NULL,
  currency           TEXT         NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  -- One row per (widget session, discovered wallet). A discovery emits many
  -- wallets under one token, so the pair is the natural key.
  UNIQUE (widget_session_id, external_wallet_id)
);

CREATE INDEX IF NOT EXISTS discovery_sessions_expires_idx
  ON public.discovery_sessions (expires_at);

-- RLS: only the service role (from edge functions) ever touches this table.
-- Enable RLS with no policies so any read via the anon or authenticated key
-- returns nothing, independent of grants (defense in depth).
ALTER TABLE public.discovery_sessions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Grant lockdown: browser-facing roles hold NOTHING on this table.
-- ============================================================
-- Stock Supabase hands anon and authenticated table-level grants on new
-- tables. account_key is account-identifying, so clear those grants outright.
-- service_role keeps its access (the edge functions run as service_role).
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE NOTICE 'role % does not exist, skipping', role_name;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.discovery_sessions FROM %I', role_name);
  END LOOP;
END
$$;

-- ============================================================
-- Assertions: this migration proves its own end state or it fails.
-- ============================================================
DO $$
DECLARE
  role_name TEXT;
BEGIN
  -- Half one: no browser-facing role holds any privilege on the table, in any
  -- mode. has_any_column_privilege answers true for a table-level or a
  -- column-level grant, so residue in either shape fails the migration rather
  -- than sitting loaded behind some future permissive policy.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;
    IF has_any_column_privilege(role_name, 'public.discovery_sessions', 'SELECT')
       OR has_any_column_privilege(role_name, 'public.discovery_sessions', 'INSERT')
       OR has_any_column_privilege(role_name, 'public.discovery_sessions', 'UPDATE')
       OR has_table_privilege(role_name, 'public.discovery_sessions', 'DELETE')
    THEN
      RAISE EXCEPTION 'discovery_sessions must not be reachable by role %, it holds account keys', role_name;
    END IF;
  END LOOP;

  -- Half two: the server-side path is intact. or-discover-wallets writes and
  -- or-link-complete reads/deletes as service_role. If this file ever costs
  -- service_role that access, the connect flow breaks silently, so fail loudly.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    IF NOT has_table_privilege('service_role', 'public.discovery_sessions', 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.discovery_sessions', 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.discovery_sessions', 'DELETE')
    THEN
      RAISE EXCEPTION 'service_role lost access to discovery_sessions, the connect discovery flow would break';
    END IF;
  END IF;
END
$$;

COMMENT ON TABLE public.discovery_sessions IS
  'Server-side map from a discovered wallet''s opaque external_wallet_id to the provider''s real per-account key, for the widget connect flow. Written by or-discover-wallets, read by or-link-complete to compute the internal dedup fingerprint. service_role only: no anon or authenticated grant, ever. Rows cascade-delete with their pending_widget_sessions parent.';

COMMENT ON COLUMN public.discovery_sessions.account_key IS
  'Provider''s real per-account key (e.g. a Strike receiverId). Account-identifying, server-side only. Never emitted to any client, API response, or log line.';

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- The table is additive and holds only short-lived session rows, so the undo
-- is a clean drop. No data of record is lost.
--
--   DROP TABLE IF EXISTS public.discovery_sessions;
