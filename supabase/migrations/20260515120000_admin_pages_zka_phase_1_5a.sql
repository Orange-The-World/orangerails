-- ============================================================
-- Phase 1.5a — Customer ZKA foundation
-- ============================================================
-- See: Apps/🚂 Orange Rails/Roadmap §Phase 1 / Sprint 1
-- See: Apps/🚂 Orange Rails/Features/Admin Pages — ZKA Addendum
--
-- This migration adds the schema /portal needs to support a per-
-- customer vault with a 2-of-3 Shamir recovery split. The customer
-- holds shares 1 and 2; Orange Rails holds share 3.
--
-- Goals:
--   * Mirror user_vault_meta for /portal users (customer_vault_meta)
--   * Persist OR's one Shamir share per customer (customer_recovery_shares)
--   * Add an opt-in encrypted_payload column to the five admin tables
--     so future writes can be ciphertext without breaking the read
--     path that still expects plaintext (Phase 1.5a does not flip the
--     read path; Phase 1.5b/c do, behind a feature flag)
--
-- This migration is additive and reversible. No existing rows change.

-- ============================================================
-- 1. customer_vault_meta — per-customer vault metadata
-- ============================================================
-- Mirror of user_vault_meta keyed by customer_id instead of user_id.
-- The shape is intentionally the same so the browser-side helpers
-- (src/lib/vault.ts) can target either table with the same code path.

CREATE TABLE IF NOT EXISTS public.customer_vault_meta (
  customer_id                UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  vault_salt                 TEXT NOT NULL,
  vault_verifier_ciphertext  TEXT NOT NULL,
  vault_key_version          INTEGER NOT NULL DEFAULT 1,
  kdf_algorithm              TEXT NOT NULL DEFAULT 'argon2id-v1',
  kdf_params                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  enc_mek_ciphertext         TEXT,
  recovery_ciphertext        TEXT,
  pqc_key_version            INTEGER NOT NULL DEFAULT 1,
  kem_public_key             TEXT,
  kem_secret_wrapped         TEXT,
  sig_public_key             TEXT,
  sig_secret_wrapped         TEXT,
  workspace_key_id           UUID,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_vault_meta ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers read own vault meta"
  ON public.customer_vault_meta FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
    OR public.is_staff()
  );

CREATE POLICY "Customers upsert own vault meta"
  ON public.customer_vault_meta FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "Customers update own vault meta"
  ON public.customer_vault_meta FOR UPDATE
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
  );

CREATE TRIGGER trg_customer_vault_meta_updated_at
  BEFORE UPDATE ON public.customer_vault_meta
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 2. customer_recovery_shares — OR's one Shamir share per customer
-- ============================================================
-- 2-of-3 Shamir split. The customer keeps share 1 (in their browser,
-- derived from their vault password) and share 2 (downloaded as a
-- PDF/QR at setup time). Share 3 lives here, sealed against an
-- Orange Rails team key.
--
-- Why a separate table from customer_vault_meta: the share is sealed
-- with a *different* key (the OR team key), not the customer's vault
-- key. Splitting tables keeps the trust boundaries explicit and the
-- RLS policies simpler.

CREATE TABLE IF NOT EXISTS public.customer_recovery_shares (
  customer_id           UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  share_ciphertext      TEXT NOT NULL,
  share_index           INTEGER NOT NULL DEFAULT 3 CHECK (share_index BETWEEN 1 AND 3),
  shamir_threshold      INTEGER NOT NULL DEFAULT 2,
  shamir_total_shares   INTEGER NOT NULL DEFAULT 3,
  team_key_version      INTEGER NOT NULL DEFAULT 1,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_recovery_shares_team_key_version
  ON public.customer_recovery_shares(team_key_version);

ALTER TABLE public.customer_recovery_shares ENABLE ROW LEVEL SECURITY;

-- Customers cannot read OR's recovery share (only staff can,
-- through a recovery flow). They can insert their share at setup.
CREATE POLICY "Customers insert own recovery share"
  ON public.customer_recovery_shares FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "Staff read recovery shares"
  ON public.customer_recovery_shares FOR SELECT
  TO authenticated
  USING (public.is_staff());

CREATE POLICY "Staff update recovery shares"
  ON public.customer_recovery_shares FOR UPDATE
  TO authenticated
  USING (public.is_staff());

CREATE TRIGGER trg_customer_recovery_shares_updated_at
  BEFORE UPDATE ON public.customer_recovery_shares
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 3. encrypted_payload columns on the five admin tables
-- ============================================================
-- Phase 1.5a stages the move to encrypted-at-rest by adding an
-- additive encrypted_payload column to each admin table. Reads in
-- Phase 1.5a still pull plaintext columns. Phase 1.5b/c will flip
-- writes to seal into encrypted_payload and reads to decrypt out of
-- it (behind a feature flag, with a window where both work).
--
-- Column type is TEXT (base64 ciphertext) plus the encryption key
-- version it was sealed under, so we can rotate without a backfill.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS encrypted_payload      TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_payload_kv   INTEGER;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS encrypted_payload      TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_payload_kv   INTEGER;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS encrypted_payload      TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_payload_kv   INTEGER;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS encrypted_payload      TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_payload_kv   INTEGER;

ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS encrypted_payload      TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_payload_kv   INTEGER;

-- ============================================================
-- 4. Comments
-- ============================================================

COMMENT ON TABLE public.customer_vault_meta IS
  'Per-customer vault metadata. Mirror of user_vault_meta keyed by customer_id for /portal users. Holds the salt + verifier + KEM/sig keys needed to unlock the customer vault in-browser.';

COMMENT ON TABLE public.customer_recovery_shares IS
  'Orange Rails one Shamir share per customer in a 2-of-3 split. Customer holds shares 1 and 2 (browser-derived + PDF). Share 3 (here) is sealed against an OR team key. Staff-only read access.';

COMMENT ON COLUMN public.customers.encrypted_payload IS
  'Phase 1.5a additive ciphertext column. Phase 1.5b/c flip writes to seal sensitive customer fields into here behind a feature flag. Reads remain plaintext until cutover.';
