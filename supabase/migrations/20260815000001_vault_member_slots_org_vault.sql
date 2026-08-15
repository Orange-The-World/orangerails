-- 20260815000001_vault_member_slots_org_vault.sql
-- DL-0418 base + DL-0514 Section 13 (pre-OQ-6)
-- OQ-6 additive (recovery_slot_alg, widened kem_pubkey CHECK, version byte) = SEPARATE migration

-- [DL-0418] One X25519 keypair per user
CREATE TABLE IF NOT EXISTS public.user_vault_pubkeys (
  user_id                     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  x25519_public_key           bytea       NOT NULL,
  enc_x25519_privkey          bytea       NOT NULL,
  recovery_enc_x25519_privkey bytea       NOT NULL,
  registered_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_vault_pubkeys ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_uvp_pubkey_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.x25519_public_key IS DISTINCT FROM OLD.x25519_public_key THEN
    RAISE EXCEPTION 'x25519_public_key is immutable after registration';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_uvp_pubkey_immutable
  BEFORE UPDATE ON public.user_vault_pubkeys
  FOR EACH ROW EXECUTE FUNCTION public.fn_uvp_pubkey_immutable();

-- [DL-0418] Per-vault per-member ECIES-wrapped MEK slot
CREATE TABLE IF NOT EXISTS public.vault_member_slots (
  vault_id       uuid        NOT NULL,
  member_user_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role           text        NOT NULL CHECK (role IN ('admin', 'member')),
  member_slot    bytea       NOT NULL,
  added_by       uuid        NOT NULL REFERENCES auth.users(id),
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, member_user_id)
);
ALTER TABLE public.vault_member_slots ENABLE ROW LEVEL SECURITY;

-- [DL-0418] vault_version: optimistic locking CAS
ALTER TABLE public.subaccount_vault_meta
  ADD COLUMN IF NOT EXISTS vault_version integer NOT NULL DEFAULT 0;

-- [DL-0514 S13] Extend vault_mode
ALTER TABLE public.subaccount_vault_meta
  DROP CONSTRAINT IF EXISTS vault_mode_values,
  ADD CONSTRAINT vault_mode_values CHECK (vault_mode IN ('single', 'multi', 'org'));

-- [DL-0514 S13] Admin inactivity tracking
-- @DBA confirm not already present from DL-0418
ALTER TABLE public.vault_member_slots
  ADD COLUMN IF NOT EXISTS last_vault_activity_at timestamptz NOT NULL DEFAULT now();

-- [DL-0514 S13] Org vault metadata
CREATE TABLE public.org_vault_meta (
  vault_id                    uuid        PRIMARY KEY,
  org_recovery_kem_pubkey     bytea       NOT NULL,
  org_recovery_sig_pubkey     bytea       NOT NULL,
  org_vault_recovery_slot     bytea       NOT NULL,
  recovery_slot_version       integer     NOT NULL DEFAULT 0,
  recovery_code_seen_by       uuid[]      NOT NULL DEFAULT '{}',
  break_glass_notify_at       timestamptz,
  break_glass_available_at    timestamptz,
  rotation_required           boolean     NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(org_recovery_kem_pubkey) = 32),
  CHECK (octet_length(org_vault_recovery_slot) BETWEEN 92 AND 1700)
);

-- [DL-0514 S13] Recovery challenge nonces
CREATE TABLE public.org_recovery_challenges (
  nonce_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id    uuid        NOT NULL REFERENCES public.org_vault_meta(vault_id) ON DELETE CASCADE,
  nonce_bytes bytea       NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  source_ip   inet
);
CREATE INDEX ON public.org_recovery_challenges(vault_id, issued_at);
CREATE INDEX ON public.org_recovery_challenges(issued_at) WHERE consumed_at IS NULL;
