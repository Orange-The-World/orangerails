-- ============================================================
-- source_wallets — per-wallet sync selection (Bitwarden-style hybrid)
-- ============================================================
-- Adds per-wallet sync to OR's provider adapters (Blink today,
-- Coinbase / Strike / others later).
--
-- Encryption choice — Option C, Bitwarden-style hybrid:
--   - external_wallet_id  : plaintext (opaque UUID from the provider).
--                           Server needs it to fetch wallet-scoped data.
--   - is_synced           : plaintext boolean.
--                           Server filters on it before calling the provider.
--   - encrypted_metadata  : ORK-encrypted blob containing { currency, label? }.
--                           Sensitive (currency reveals USD-vs-BTC behavior;
--                           labels may leak counterparty info), so it stays
--                           opaque to the server.
--
-- This mirrors how Bitwarden separates indexable identifiers from sensitive
-- payload — the server can route sync requests without ever seeing the
-- semantic content of a wallet.
--
-- RLS pattern mirrors connections / encrypted_transactions: scope via
-- connections → subaccounts → "direct" platform for direct-mode users;
-- platform-mode access flows through edge functions using the service role
-- (subaccount ownership is enforced server-side in platform-auth.ts).

CREATE TABLE IF NOT EXISTS public.source_wallets (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id                   UUID NOT NULL REFERENCES public.connections(id) ON DELETE CASCADE,
  external_wallet_id              TEXT NOT NULL,
  is_synced                       BOOLEAN NOT NULL DEFAULT true,
  encrypted_metadata              TEXT NOT NULL,
  encrypted_metadata_key_version  INTEGER NOT NULL DEFAULT 1,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_wallet_id)
);

CREATE INDEX idx_source_wallets_connection ON public.source_wallets(connection_id);

ALTER TABLE public.source_wallets ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS — direct mode (orangerails.com/app authenticated users)
-- ============================================================
-- Mirrors the four-policy pattern used on connections in
-- 20260421200000_platforms_subaccounts.sql lines 147-189.

DROP POLICY IF EXISTS "Direct users can read source_wallets via their subaccount" ON public.source_wallets;
CREATE POLICY "Direct users can read source_wallets via their subaccount"
  ON public.source_wallets FOR SELECT
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can insert source_wallets via their subaccount" ON public.source_wallets;
CREATE POLICY "Direct users can insert source_wallets via their subaccount"
  ON public.source_wallets FOR INSERT
  TO authenticated
  WITH CHECK (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can update source_wallets via their subaccount" ON public.source_wallets;
CREATE POLICY "Direct users can update source_wallets via their subaccount"
  ON public.source_wallets FOR UPDATE
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can delete source_wallets via their subaccount" ON public.source_wallets;
CREATE POLICY "Direct users can delete source_wallets via their subaccount"
  ON public.source_wallets FOR DELETE
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

-- Platform-mode access (BitBooks V3, Personal, etc.) does not use RLS —
-- those edge functions authenticate via X-Platform-API-Key and use the
-- service-role client (`ctx.serviceClient` in platform-auth.ts), which
-- bypasses RLS. Subaccount ownership is enforced in code via
-- resolveSubaccount() before any source_wallets read/write.

COMMENT ON TABLE public.source_wallets IS
  'Per-connection wallet selection. Bitwarden-style hybrid: external_wallet_id and is_synced are plaintext so the server can filter sync targets; encrypted_metadata holds sensitive {currency, label} encrypted with the user''s ORK. Empty for legacy connections — or-sync falls back to provider-default behavior.';

COMMENT ON COLUMN public.source_wallets.external_wallet_id IS
  'Opaque wallet identifier as returned by the upstream provider (e.g., Blink wallet UUID). Plaintext — needed by the server to scope provider API calls.';

COMMENT ON COLUMN public.source_wallets.is_synced IS
  'Whether or-sync should pull transactions for this wallet. Plaintext so the server can filter before contacting the provider.';

COMMENT ON COLUMN public.source_wallets.encrypted_metadata IS
  'AES-256-GCM ciphertext of JSON {currency, label?} encrypted with the connection owner''s ORK (transactions subkey, matching encrypted_label on connections). Server cannot decrypt.';
