-- UNDO (run this to reverse the migration):
--   ALTER TABLE public.source_wallets DROP CONSTRAINT IF EXISTS source_wallets_server_discovery_no_metadata_ck;
--   ALTER TABLE public.source_wallets DROP CONSTRAINT IF EXISTS source_wallets_discovery_source_ck;
--   ALTER TABLE public.source_wallets DROP COLUMN IF EXISTS discovery_source;

-- Add discovery_source column to label how a source_wallet row was created.
--   'client' = the user's browser discovered and submitted this wallet via the Link widget.
--   'server' = the server discovered this wallet directly from the provider API.
--   NULL     = legacy row created before this column existed (treat as client-discovered).
--
-- The key invariant: a server-discovered wallet must never carry encrypted_metadata,
-- because the server cannot produce ZKA-compliant ciphertext (it does not hold the
-- user key). This constraint is enforced at the DB layer so no code path can
-- accidentally write plaintext content into a field that must stay opaque to the server.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'source_wallets'
      AND column_name  = 'discovery_source'
  ) THEN
    ALTER TABLE public.source_wallets
      ADD COLUMN discovery_source TEXT;
  END IF;
END;
$$;

-- Constraint 1: discovery_source must be a known value when set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.source_wallets'::regclass
      AND conname  = 'source_wallets_discovery_source_ck'
  ) THEN
    ALTER TABLE public.source_wallets
      ADD CONSTRAINT source_wallets_discovery_source_ck
      CHECK (discovery_source IN ('server', 'client'));
  END IF;
END;
$$;

-- Constraint 2: server-discovered rows must not carry encrypted_metadata.
-- The server cannot produce ZKA ciphertext, so anything stored here from
-- the server path would either be plaintext (self-custody violation) or
-- ciphertext the server cannot decrypt (useless). Neither is acceptable.
-- Blocking it at the constraint layer makes the invariant systemic rather
-- than a promise kept by individual writers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.source_wallets'::regclass
      AND conname  = 'source_wallets_server_discovery_no_metadata_ck'
  ) THEN
    ALTER TABLE public.source_wallets
      ADD CONSTRAINT source_wallets_server_discovery_no_metadata_ck
      CHECK (NOT (discovery_source = 'server' AND encrypted_metadata IS NOT NULL));
  END IF;
END;
$$;

COMMENT ON COLUMN public.source_wallets.discovery_source IS
  'How this wallet row was created: ''client'' (user submitted via Link widget with '
  'encrypted metadata), ''server'' (server-discovered from provider API, no encrypted '
  'metadata allowed). NULL means legacy row created before this column existed.';
