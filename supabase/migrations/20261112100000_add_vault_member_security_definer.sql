-- ============================================================
-- add_vault_member: SECURITY DEFINER INSERT path for vault_member_slots
-- ============================================================
-- Ticket:  OR-T2240
-- Parent:  OR-T0682 (org vault member add)
-- Ruling:  cryptography-engineer spec 2026-11-10 (msg 26249 on OR-T2240)
--
-- WHY
-- ---
-- vault_member_slots has only a SELECT RLS policy (vms_member_select).
-- There is no INSERT policy and no INSERT path, so a vault admin cannot
-- add a second member to a vault. This SECURITY DEFINER function is the
-- controlled INSERT path.
--
-- The server never sees the plaintext vault key. The member_slot bytea
-- is the vault key wrapped with the recipient X25519 public key,
-- produced client-side. This function does NOT verify the cryptographic
-- content of member_slot; it cannot and must not.
--
-- WHAT THIS FUNCTION DOES
-- -----------------------
-- 1. Verifies the caller is authenticated and is an admin of the vault.
-- 2. Verifies the target member_user_id has a registered X25519 public key.
-- 3. Inserts the vault_member_slots row.
-- 4. Logs the event to vault_security_events.
--
-- WHAT THIS FUNCTION DOES NOT DO
-- --------------------------------
-- Does NOT inspect or validate the ciphertext in member_slot.
-- Does NOT grant any new RLS policy.
-- Does NOT remove or change the existing SELECT-only RLS policy.

CREATE OR REPLACE FUNCTION public.add_vault_member(
  p_vault_id        uuid,
  p_member_user_id  uuid,
  p_member_slot     bytea,
  p_role            text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id  uuid    := auth.uid();
  v_is_admin   boolean;
  v_pubkey     bytea;
BEGIN
  -- Caller must be authenticated.
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
  END IF;

  -- Validate role value. The vault_member_slots check constraint also
  -- enforces this, but an early explicit check gives a clearer error.
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid_role: must be admin or member' USING ERRCODE = '22023';
  END IF;

  -- Caller must be an admin of this vault.
  SELECT EXISTS (
    SELECT 1 FROM public.vault_member_slots
     WHERE vault_id       = p_vault_id
       AND member_user_id = v_caller_id
       AND role           = 'admin'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'not_vault_admin' USING ERRCODE = '42501';
  END IF;

  -- Target member must have a registered X25519 public key.
  -- The client wraps the vault key with this key; if the row is absent
  -- the client cannot have produced a valid member_slot.
  SELECT x25519_public_key INTO v_pubkey
    FROM public.user_vault_pubkeys
   WHERE user_id = p_member_user_id;

  IF v_pubkey IS NULL THEN
    RAISE EXCEPTION 'member_pubkey_not_registered' USING ERRCODE = '23000';
  END IF;

  -- Insert the member slot.
  -- The cryptographic content of member_slot is NOT verified.
  -- The server has no plaintext vault key and cannot verify the wrapping.
  INSERT INTO public.vault_member_slots (
    vault_id, member_user_id, role, member_slot,
    added_by, added_at, last_vault_activity_at
  )
  VALUES (
    p_vault_id, p_member_user_id, p_role, p_member_slot,
    v_caller_id, now(), now()
  );

  -- Audit log.
  INSERT INTO public.vault_security_events (user_id, event, metadata)
  VALUES (
    v_caller_id,
    'member_added',
    jsonb_build_object(
      'vault_id',       p_vault_id,
      'member_user_id', p_member_user_id,
      'role',           p_role,
      'ts',             now()
    )
  );

END;
$$;

-- Grants match lookup_vault_pubkey: service_role and authenticated.
-- anon is intentionally excluded: only an authenticated vault admin can
-- add a member.
REVOKE ALL  ON FUNCTION public.add_vault_member(uuid, uuid, bytea, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_vault_member(uuid, uuid, bytea, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.add_vault_member(uuid, uuid, bytea, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.add_vault_member(uuid, uuid, bytea, text) TO authenticated;
