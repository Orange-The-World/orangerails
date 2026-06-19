-- ============================================================
-- OPK / OSK keypair + Quiltt platform Model-B slots + sealed_under marker
-- on encrypted_transactions. Foundation for the Quiltt automated-sync
-- helper (wiki page 11 — "Automated sync for ZKA apps and V2").
-- ============================================================
-- Three changes, all additive + backward compatible:
--
-- 1. subaccounts gets opk_public + opk_alg + opk_registered_at columns.
--    These are the per-user "delivery key" (X25519 public key) used by
--    or-quiltt-sync and any other background writer to seal new
--    transactions for ZKA tenants. Browser holds the matching private
--    key (OSK), never sent to the server. Until a subaccount has
--    opk_public set, background sync for that user is on hold.
--
-- 2. encrypted_transactions gets sealed_under + sealed_alg columns.
--    - sealed_under = 'ort' (default) → existing path: ciphertext was
--      encrypted with the user's symmetric ORT during a sync session.
--    - sealed_under = 'opk' → new path: ciphertext was encrypted with
--      the subaccount's OPK by a background writer (e.g. or-quiltt-sync
--      receiving a Quiltt webhook while the user is offline).
--    sealed_alg records the suite (e.g. 'libsodium-crypto_box_seal-v1')
--    so future rotation knows how to decrypt-then-reseal.
--
-- 3. platforms gets quiltt_api_key_ciphertext + quiltt_environment_id.
--    These are the Model-B slots: a tenant can bring its own Quiltt
--    contract by populating these. When NULL, or-quiltt-session falls
--    back to OR's master QUILTT_API_KEY (Model A). The ciphertext is
--    encrypted with the OR service's own key — never logged, never sent
--    to integrators.
--
-- All additions are nullable / default-bearing so existing rows continue
-- to work unchanged.

-- ── 1. subaccounts: OPK columns ─────────────────────────────────────

ALTER TABLE public.subaccounts
  ADD COLUMN IF NOT EXISTS opk_public        TEXT,
  ADD COLUMN IF NOT EXISTS opk_alg           TEXT,
  ADD COLUMN IF NOT EXISTS opk_registered_at TIMESTAMPTZ;

COMMENT ON COLUMN public.subaccounts.opk_public IS
  'Per-subaccount X25519 public key (base64, libsodium crypto_box_seal). Set when the user opts in to background sync. NULL means no background writer is allowed for this subaccount.';
COMMENT ON COLUMN public.subaccounts.opk_alg IS
  'OPK crypto suite identifier, e.g. ''libsodium-crypto_box_seal-v1''.';
COMMENT ON COLUMN public.subaccounts.opk_registered_at IS
  'When the current OPK was registered. Rotation updates this.';

-- Validate OPK pieces are set together (both or neither).
ALTER TABLE public.subaccounts
  ADD CONSTRAINT subaccounts_opk_complete CHECK (
    (opk_public IS NULL AND opk_alg IS NULL AND opk_registered_at IS NULL)
    OR
    (opk_public IS NOT NULL AND opk_alg IS NOT NULL AND opk_registered_at IS NOT NULL)
  );

-- ── 2. encrypted_transactions: sealed_under + sealed_alg ────────────

ALTER TABLE public.encrypted_transactions
  ADD COLUMN IF NOT EXISTS sealed_under TEXT NOT NULL DEFAULT 'ort'
    CHECK (sealed_under IN ('ort', 'opk')),
  ADD COLUMN IF NOT EXISTS sealed_alg   TEXT;

COMMENT ON COLUMN public.encrypted_transactions.sealed_under IS
  '''ort'' = symmetric, encrypted with the user''s ORT during a sync session (existing path). ''opk'' = asymmetric, sealed with the subaccount''s OPK by a background writer.';
COMMENT ON COLUMN public.encrypted_transactions.sealed_alg IS
  'When sealed_under=''opk'', records the crypto suite used so the browser knows how to unseal.';

-- ── 3. platforms: Model-B Quiltt key slots ──────────────────────────

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS quiltt_api_key_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS quiltt_environment_id     TEXT;

COMMENT ON COLUMN public.platforms.quiltt_api_key_ciphertext IS
  'Optional per-platform Quiltt API key (Model B — bring-your-own-Quiltt). Encrypted at rest. NULL → OR''s master key (Model A) is used.';
COMMENT ON COLUMN public.platforms.quiltt_environment_id IS
  'Optional Quiltt environmentId paired with quiltt_api_key_ciphertext. Used to route inbound Quiltt webhooks back to this platform.';

-- Partial index for fast environment_id lookup during webhook routing.
CREATE INDEX IF NOT EXISTS idx_platforms_quiltt_environment_id
  ON public.platforms (quiltt_environment_id)
  WHERE quiltt_environment_id IS NOT NULL;
