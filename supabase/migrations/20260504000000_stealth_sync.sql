-- ============================================================
-- Stealth Sync — sealed envelope + sealed transaction storage.
-- ============================================================
-- Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.2
--
-- Two tables back the new browser-side wallet flow:
--   stealth_connections    one row per xpub / descriptor a user has added.
--                          Holds the sealed envelope OR cannot decrypt.
--   stealth_transactions   append-only log of sealed normalized transactions
--                          posted by the widget after a scan completes.
--
-- OR's edge functions (or-stealth-*) are the only path through which these
-- rows are read or written. RLS enforces that a row's app_user_id matches
-- the JWT subject; the edge functions use the service-role client and the
-- caller's authenticated identity to scope queries.

-- ───────────────────────────────────────────────────────────
-- stealth_connections
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stealth_connections (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id                 UUID         NOT NULL,
  app_slug                    TEXT         NOT NULL,
  connection_kind             TEXT         NOT NULL
                                CHECK (connection_kind IN ('xpub_stealth','descriptor_stealth')),
  sealed_envelope             JSONB        NOT NULL,
  wallet_birthday_plaintext   DATE,
  status                      TEXT         NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','error','archived')),
  last_sync_at                TIMESTAMPTZ,
  last_block_scanned          INTEGER,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stealth_connections IS
  'Stealth Sync sealed envelope storage. The sealed_envelope column is opaque ciphertext to OR; only the consuming app holds the key (per §4.3 of the master plan).';

COMMENT ON COLUMN public.stealth_connections.app_user_id IS
  'Opaque per-app user identifier (org id for V2, user id for V3/OW). OR uses it for routing and RLS only.';

COMMENT ON COLUMN public.stealth_connections.sealed_envelope IS
  'JSONB holding a SealedEnvelope (see src/stealth/lib/postmessage.ts). version + algorithm + iv_b64 + ciphertext_b64.';

COMMENT ON COLUMN public.stealth_connections.wallet_birthday_plaintext IS
  'OPTIONAL plaintext birthday for consuming apps that already hold this date plaintext (V2 has it as balanceDate). V3/OW should omit and keep the birthday inside the envelope.';

CREATE INDEX IF NOT EXISTS stealth_connections_app_user_idx
  ON public.stealth_connections (app_user_id, app_slug);

CREATE INDEX IF NOT EXISTS stealth_connections_last_sync_idx
  ON public.stealth_connections (last_sync_at);

-- ───────────────────────────────────────────────────────────
-- stealth_transactions
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stealth_transactions (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id          UUID         NOT NULL REFERENCES public.stealth_connections(id) ON DELETE CASCADE,
  sealed_record          JSONB        NOT NULL,
  occurred_at            DATE         NOT NULL,
  block_height           INTEGER      NOT NULL,
  txid_blind_index_b64   TEXT         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (connection_id, txid_blind_index_b64)
);

COMMENT ON TABLE public.stealth_transactions IS
  'Sealed normalized transactions produced by the OR Connect widget after a BIP158 scan. sealed_record is opaque to OR.';

COMMENT ON COLUMN public.stealth_transactions.occurred_at IS
  'Plaintext block date for indexed range queries. Matches V3 ZKA Level 2 trade-off (see §4.3 master plan).';

COMMENT ON COLUMN public.stealth_transactions.txid_blind_index_b64 IS
  'HMAC of txid under the per-app stealth key. Lets the server dedup without learning the txid.';

CREATE INDEX IF NOT EXISTS stealth_transactions_conn_occurred_idx
  ON public.stealth_transactions (connection_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS stealth_transactions_conn_height_idx
  ON public.stealth_transactions (connection_id, block_height DESC);

-- ───────────────────────────────────────────────────────────
-- updated_at maintenance trigger
-- ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stealth_connections_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stealth_connections_touch_updated_at ON public.stealth_connections;
CREATE TRIGGER stealth_connections_touch_updated_at
  BEFORE UPDATE ON public.stealth_connections
  FOR EACH ROW EXECUTE FUNCTION public.stealth_connections_touch_updated_at();

-- ───────────────────────────────────────────────────────────
-- RLS
-- ───────────────────────────────────────────────────────────
-- Edge functions (or-stealth-*) are the only writers; they use the
-- service-role client and have already authenticated the caller via
-- the existing platform-auth.ts helpers. The policies below provide
-- a defense-in-depth check for any non-edge-function read that lands
-- on these tables (e.g. someone forgetting to gate a future RPC).
--
-- The check matches the row's app_user_id against the JWT subject.
-- For platform-mode requests the JWT is absent and the service-role
-- client bypasses RLS, which is the same pattern used in
-- 20260420120000_pqc_keys.sql and the existing connections table.

ALTER TABLE public.stealth_connections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stealth_transactions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read their stealth connections" ON public.stealth_connections;
CREATE POLICY "Owners can read their stealth connections"
  ON public.stealth_connections
  FOR SELECT
  USING (auth.uid()::text = app_user_id::text);

DROP POLICY IF EXISTS "Owners can read their stealth transactions" ON public.stealth_transactions;
CREATE POLICY "Owners can read their stealth transactions"
  ON public.stealth_transactions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.stealth_connections sc
      WHERE sc.id = stealth_transactions.connection_id
        AND auth.uid()::text = sc.app_user_id::text
    )
  );
