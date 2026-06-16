-- 20260616180000_opk_rotation_audit.sql
--
-- Defense-in-depth for OPK rotation. Today or-sync-key-register silently
-- overwrites subaccounts.opk_public when the caller posts a different
-- public key. Anyone who can reach the endpoint with a valid platform key
-- + matching app_user_id can flip a victim's pubkey to attacker-controlled,
-- and every subsequent sealed transaction decrypts to attacker. The proxy
-- layer (OWM bb-or-proxy) prevents app_user_id spoofing today, but the
-- attack surface should not depend on a single integrator's convention.
--
-- Two changes ship with this migration:
--   1. Every rotation gets a permanent audit row in opk_key_rotations.
--      Append-only, service-role only. Investigates after-the-fact.
--   2. The function now requires explicit `confirm_rotation: true` in the
--      request body before overwriting a non-null opk_public. Quiet
--      "oops we wrote the wrong key" client bugs now 409 instead of
--      silently rotating.
--
-- A future migration will add cryptographic rotation proof (X25519
-- challenge-response) so the integrator backend cannot rotate on behalf
-- of the user without the user's prior OPK private key. That requires
-- shipping a corresponding signer in OWM.

CREATE TABLE IF NOT EXISTS public.opk_key_rotations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subaccount_id      UUID NOT NULL REFERENCES public.subaccounts(id) ON DELETE CASCADE,
  platform_id        UUID NOT NULL REFERENCES public.platforms(id),
  old_opk_public     TEXT,
  new_opk_public     TEXT NOT NULL,
  old_opk_alg        TEXT,
  new_opk_alg        TEXT NOT NULL,
  rotated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotation_reason    TEXT,
  request_ip         TEXT
);

CREATE INDEX IF NOT EXISTS opk_key_rotations_subaccount_idx
  ON public.opk_key_rotations (subaccount_id, rotated_at DESC);

ALTER TABLE public.opk_key_rotations ENABLE ROW LEVEL SECURITY;

-- No policies → deny-by-default → service-role only.

COMMENT ON TABLE public.opk_key_rotations IS
  'Append-only audit log of OPK public-key rotations on subaccounts. Service-role only. Every rotation in or-sync-key-register writes one row.';
