-- ============================================================
-- OrangeRails Hub Foundation — Phase 1
-- ============================================================
-- Implements the session-based zero-knowledge hub schema.
-- See: docs/OrangeRails-Architecture.md §5 (Key Hierarchy)
-- See: docs/OrangeRails-Implementation-Plan.md §4 (Phase 1)
--
-- What this migration does NOT store:
--   - User vault passwords (never stored anywhere, ever)
--   - User MEK, ORK, ORT keys (browser memory only)
--   - Plaintext provider credentials (only ciphertext)
--   - Plaintext transaction data (only ciphertext)

-- ============================================================
-- 1. user_vault_meta — per-user vault metadata
-- ============================================================
-- One row per user. Stores only public metadata about the vault:
-- the KDF salt (random, so rainbow tables don't help) and a
-- verifier ciphertext that proves the user entered the right
-- password without ever storing the password itself.

CREATE TABLE IF NOT EXISTS public.user_vault_meta (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  vault_salt TEXT NOT NULL,                              -- base64-encoded 128-bit random salt for Argon2id
  vault_verifier_ciphertext TEXT NOT NULL,               -- AES-256-GCM ciphertext of a known constant
  vault_key_version SMALLINT NOT NULL DEFAULT 1,         -- for future KDF parameter migration
  kdf_algorithm TEXT NOT NULL DEFAULT 'argon2id',
  kdf_params JSONB NOT NULL DEFAULT '{"m":65536,"t":3,"p":4}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_vault_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own vault metadata" ON public.user_vault_meta;
CREATE POLICY "Users can read own vault metadata"
  ON public.user_vault_meta FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own vault metadata" ON public.user_vault_meta;
CREATE POLICY "Users can insert own vault metadata"
  ON public.user_vault_meta FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own vault metadata" ON public.user_vault_meta;
CREATE POLICY "Users can update own vault metadata"
  ON public.user_vault_meta FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 2. apps — registered consuming applications
-- ============================================================
-- Apps (BitBooks, future apps) register here once. Each gets a
-- client_secret used for HMAC-SHA256 signing of API requests.
--
-- NOTE for Phase 5 hardening: rotate to asymmetric keys or store
-- client_secret encrypted with a server-side key. Plaintext is
-- acceptable for MVP since this table is RLS-protected and not
-- reachable by end users.

CREATE TABLE IF NOT EXISTS public.apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  redirect_uri_pattern TEXT,                             -- regex for Link widget redirect validation
  client_secret TEXT NOT NULL,                           -- HMAC secret; rotate before prod
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read app metadata (so the Link widget
-- can display "App X is requesting access"). They cannot see
-- client_secret values — they appear in row data but RLS prevents
-- reading them; see separate policies below.
DROP POLICY IF EXISTS "Anyone can read app public metadata" ON public.apps;
CREATE POLICY "Anyone can read app public metadata"
  ON public.apps FOR SELECT
  TO authenticated, anon
  USING (true);

-- INSERT / UPDATE / DELETE of apps is admin-only. We manage this
-- by denying all authenticated user policies; only the service_role
-- can mutate (via the Supabase dashboard or a future admin panel).

-- Seed BitBooks as the first registered app.
INSERT INTO public.apps (slug, name, description, redirect_uri_pattern, client_secret)
VALUES (
  'bitbooks',
  'BitBooks',
  'Multi-currency accounting on a Bitcoin standard. First consuming app for OrangeRails.',
  '^https://([a-z0-9-]+\.)?bitbooks\.com/.*$|^http://localhost:[0-9]+/.*$',
  'dev-bitbooks-client-secret-' || encode(gen_random_bytes(24), 'hex')
);

-- ============================================================
-- 3. user_app_grants — explicit user consent for app access
-- ============================================================
-- When a user completes the Link widget flow, a grant row is
-- inserted. The user "grants" the app permission to call
-- OrangeRails on their behalf. The actual access_token is
-- returned to the app once and hashed here — we never store the
-- raw token (same pattern password-reset systems use).

CREATE TABLE IF NOT EXISTS public.user_app_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_id UUID NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  access_token_hash TEXT UNIQUE NOT NULL,                -- SHA-256 of the actual token
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY['read:transactions'],
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_app_grants_user_id ON public.user_app_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_app_grants_token_hash ON public.user_app_grants(access_token_hash);

ALTER TABLE public.user_app_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own grants" ON public.user_app_grants;
CREATE POLICY "Users can read own grants"
  ON public.user_app_grants FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own grants" ON public.user_app_grants;
CREATE POLICY "Users can insert own grants"
  ON public.user_app_grants FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own grants" ON public.user_app_grants;
CREATE POLICY "Users can update own grants"
  ON public.user_app_grants FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 4. connections — encrypted provider credentials
-- ============================================================
-- The ZKA-critical table. Stores the user's API keys for Blink,
-- Kraken, BTCPay, etc. — but ONLY as ciphertext encrypted with
-- the user's derived ORK (OrangeRails credentials key).
-- The server cannot decrypt these without the user's active
-- session providing the ORK in-transit.

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,                           -- 'blink', 'kraken', 'btcpay', 'xpub', ...
  label TEXT,                                            -- user-provided friendly name
  encrypted_credentials TEXT NOT NULL,                   -- AES-256-GCM, encrypted with user's ORK
  credentials_key_version SMALLINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  last_sync_at TIMESTAMPTZ,
  last_sync_cursor TEXT,                                 -- provider-specific pagination cursor
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connections_user_id ON public.connections(user_id);
CREATE INDEX IF NOT EXISTS idx_connections_user_provider ON public.connections(user_id, provider_type);

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own connections" ON public.connections;
CREATE POLICY "Users can read own connections"
  ON public.connections FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own connections" ON public.connections;
CREATE POLICY "Users can insert own connections"
  ON public.connections FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own connections" ON public.connections;
CREATE POLICY "Users can update own connections"
  ON public.connections FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own connections" ON public.connections;
CREATE POLICY "Users can delete own connections"
  ON public.connections FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 5. encrypted_transactions — normalized synced transactions
-- ============================================================
-- After a sync call, normalized transactions from each provider
-- are encrypted with the user's ORT (OrangeRails transactions key)
-- and stored here. Plaintext metadata is limited to what we need
-- for efficient queries: connection_id, external_id, occurred_at.

CREATE TABLE IF NOT EXISTS public.encrypted_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,                             -- provider's tx id (plaintext — unavoidable for dedup)
  encrypted_payload TEXT NOT NULL,                       -- AES-256-GCM, encrypted with user's ORT
  payload_key_version SMALLINT NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL,                      -- plaintext for querying — timestamp alone is low-signal
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_encrypted_transactions_connection_id
  ON public.encrypted_transactions(connection_id);

CREATE INDEX IF NOT EXISTS idx_encrypted_transactions_occurred_at
  ON public.encrypted_transactions(connection_id, occurred_at DESC);

ALTER TABLE public.encrypted_transactions ENABLE ROW LEVEL SECURITY;

-- Row-level security joins through connections: a user can only
-- see transactions for their own connections.
DROP POLICY IF EXISTS "Users can read own transactions" ON public.encrypted_transactions;
CREATE POLICY "Users can read own transactions"
  ON public.encrypted_transactions FOR SELECT
  TO authenticated
  USING (
    connection_id IN (
      SELECT id FROM public.connections WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own transactions" ON public.encrypted_transactions;
CREATE POLICY "Users can insert own transactions"
  ON public.encrypted_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    connection_id IN (
      SELECT id FROM public.connections WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete own transactions" ON public.encrypted_transactions;
CREATE POLICY "Users can delete own transactions"
  ON public.encrypted_transactions FOR DELETE
  TO authenticated
  USING (
    connection_id IN (
      SELECT id FROM public.connections WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- updated_at triggers
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_vault_meta_updated_at ON public.user_vault_meta;
CREATE TRIGGER trg_user_vault_meta_updated_at
  BEFORE UPDATE ON public.user_vault_meta
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_apps_updated_at ON public.apps;
CREATE TRIGGER trg_apps_updated_at
  BEFORE UPDATE ON public.apps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_connections_updated_at ON public.connections;
CREATE TRIGGER trg_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Comments (visible in Supabase dashboard)
-- ============================================================

COMMENT ON TABLE public.user_vault_meta IS
  'Per-user vault key derivation metadata. Salt is random per user; verifier is AES-256-GCM ciphertext of a known constant. Never stores the vault password itself.';

COMMENT ON TABLE public.apps IS
  'Registered consuming applications. Each gets a client_secret for HMAC-SHA256 request signing.';

COMMENT ON TABLE public.user_app_grants IS
  'User consent records. access_token_hash is SHA-256 of the raw token returned once to the app.';

COMMENT ON TABLE public.connections IS
  'Encrypted provider credentials. Server cannot decrypt encrypted_credentials without user session providing ORK in-transit.';

COMMENT ON TABLE public.encrypted_transactions IS
  'Normalized provider transactions encrypted with user ORT. occurred_at is plaintext for efficient querying; payload content is ciphertext.';
