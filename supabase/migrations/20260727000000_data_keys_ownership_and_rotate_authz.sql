-- ============================================================
-- data_keys ownership record (DDL only)
-- ============================================================
-- Creates the data_keys table: server-authoritative data_key_id -> owner_user_id
-- map. Written only by SECURITY DEFINER functions; client writes blocked by RLS
-- so ownership cannot be forged.
--
-- ZKA: data_keys(owner_user_id) is an ownership mapping, not key plaintext.
-- The envelope crypto model is unchanged; the server never sees a plaintext key.
--
-- The rotate_data_key function (current-membership authz + grant_sig) lives in
-- 20260806200000_rotate_data_key_current_membership_and_grant_sig.sql so this
-- file applies cleanly before 20260805000000 / 20260805100000 in date order.
--
-- Reversibility (down-path):
--   ALTER TABLE public.wrapped_data_keys DROP CONSTRAINT IF EXISTS wrapped_data_keys_data_key_id_fk;
--   DROP TABLE IF EXISTS public.data_keys;

-- ------------------------------------------------------------
-- 1. Server-authoritative ownership record
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_keys (
  data_key_id   UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_keys IS
  'Authoritative data_key_id -> owner_user_id map. Written only by SECURITY DEFINER functions; client writes are blocked by RLS so ownership cannot be forged. Not key plaintext.';

-- Ownership rows are written only by the definer function below. RLS is enabled
-- with a read-only policy for the owner and NO client write policy, so a caller
-- cannot INSERT/UPDATE a row claiming a key they do not own.
ALTER TABLE public.data_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'data_keys'
      AND policyname = 'data_keys_owner_select'
  ) THEN
    CREATE POLICY data_keys_owner_select ON public.data_keys
      FOR SELECT TO authenticated
      USING (owner_user_id = auth.uid());
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Backfill from the server-authoritative owner source
-- ------------------------------------------------------------
-- Source: user_vault_meta(user_id owner, workspace_key_id = data_key_id). It is
-- one row per owner keyed by the owner's own user_id, so it is NOT derived from
-- wrapped_data_keys recipiency. workspace_key_id is client-writable, so a bare
-- claim is only a backfill SOURCE, never proof of ownership: we insert a row
-- only when the claim is (a) uncollided and (b) corroborated by a matching
-- wrapped_data_keys recipient row for that same user.
--
-- Uncollided: a workspace_key_id claimed by more than one user is EXCLUDED here
-- (never silently resolved) and surfaces in the promotion gate queries for the
-- Auditor to escalate. Corroborated: the claimed key must appear in
-- wrapped_data_keys with that user as a recipient.
--
-- On dev both source tables are empty, so this is a verified no-op. At prod the
-- three gate queries (collision, zero-corroboration, orphan-keys) are run and
-- pasted in Zulip, with every nonzero row escalated, BEFORE the FK is validated.
INSERT INTO public.data_keys (data_key_id, owner_user_id)
SELECT uvm.workspace_key_id, uvm.user_id
FROM public.user_vault_meta uvm
WHERE uvm.workspace_key_id IS NOT NULL
  -- uncollided: exactly one owner claims this key
  AND NOT EXISTS (
    SELECT 1 FROM public.user_vault_meta other
    WHERE other.workspace_key_id = uvm.workspace_key_id
      AND other.user_id <> uvm.user_id
  )
  -- corroborated: the owner is a recipient of the key they claim
  AND EXISTS (
    SELECT 1 FROM public.wrapped_data_keys wdk
    WHERE wdk.data_key_id = uvm.workspace_key_id
      AND wdk.recipient_user_id = uvm.user_id
  )
ON CONFLICT (data_key_id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Integrity FK: every wrapped envelope's key has an owner record
-- ------------------------------------------------------------
-- Added guarded so a re-run cannot wedge. At prod this is applied only after the
-- gate queries confirm zero un-owned keys (orphans escalated first).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wrapped_data_keys_data_key_id_fk'
  ) THEN
    ALTER TABLE public.wrapped_data_keys
      ADD CONSTRAINT wrapped_data_keys_data_key_id_fk
      FOREIGN KEY (data_key_id) REFERENCES public.data_keys(data_key_id);
  END IF;
END $$;

-- rotate_data_key function (current-membership authz + grant_sig) is in
-- 20260806200000_rotate_data_key_current_membership_and_grant_sig.sql
-- Split here so this file applies cleanly before 20260805000000 / 20260805100000
-- in date order and does not clobber the grant_sig-aware function on prod.
