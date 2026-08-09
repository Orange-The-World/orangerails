-- ============================================================
-- rotate_data_key: current-membership authz + grant_sig insert
-- ============================================================
-- Reconciliation migration. Clears Auditor hold on 20260727000000 (PR #626).
--
-- Context:
--   20260727000000 added the data_keys table and rewrote rotate_data_key
--   with current-membership authz but WITHOUT grant_sig (predated DL-0619).
--   Applied in date order it lands AFTER 20260805100000 on prod and clobbers
--   the grant_sig-aware function, breaking rotation against the NOT NULL
--   constraint on wrapped_data_keys.grant_sig.
--
--   20260805000000 added grant_sig / grant_sig_alg columns and rewrote the
--   function with current-membership authz AND grant_sig. Correct, but
--   applied out of band with no ledger entry.
--
--   20260805100000 replaced the function again using old-key co-recipiency
--   (regression), while retaining grant_sig in the INSERT.
--
--   Neither 20260727000000 nor 20260805100000 alone is correct:
--   - 20260727000000 (date-order after 20260805100000): clobbers grant_sig
--     write, breaking rotation (null into NOT NULL column).
--   - 20260805100000: weak authz (old-key co-recipiency, not current-membership).
--
--   This migration, numbered after all three, is the canonical final form:
--   current-membership authz (owner or workspace_admins co-admin only) +
--   grant_sig pre-flight (fail-closed) + grant_sig and grant_sig_alg writes.
--
-- ZKA: server never sees plaintext key. Envelope crypto unchanged.
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.rotate_data_key(
  p_old_data_key_id  UUID,
  p_new_data_key_id  UUID,
  p_envelopes        JSONB,
  p_reason           TEXT DEFAULT NULL
)
RETURNS TABLE(
  new_data_key_id    UUID,
  envelopes_inserted INT,
  audit_entry_id     UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID := auth.uid();
  v_owner    UUID;
  v_count    INT  := 0;
  v_audit_id UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no auth context';
  END IF;

  IF p_old_data_key_id IS NULL THEN
    RAISE EXCEPTION 'p_old_data_key_id is required';
  END IF;

  IF p_new_data_key_id IS NULL THEN
    RAISE EXCEPTION 'p_new_data_key_id is required';
  END IF;

  IF p_new_data_key_id = p_old_data_key_id THEN
    RAISE EXCEPTION 'p_new_data_key_id must differ from p_old_data_key_id';
  END IF;

  IF p_envelopes IS NULL OR jsonb_array_length(p_envelopes) = 0 THEN
    RAISE EXCEPTION 'p_envelopes must be a non-empty JSON array';
  END IF;

  -- Pre-flight: every envelope must carry a non-empty grant_sig.
  -- Fail-closed: zero rows inserted if any envelope omits a signature.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_envelopes) e
    WHERE coalesce(e->>'grant_sig', '') = ''
  ) THEN
    RAISE EXCEPTION 'Every envelope must carry a non-empty grant_sig; refusing to rotate unsigned'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve the authoritative owner of the key being rotated out.
  SELECT owner_user_id INTO v_owner
  FROM public.data_keys
  WHERE data_key_id = p_old_data_key_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'p_old_data_key_id has no ownership record'
      USING ERRCODE = '42501';
  END IF;

  -- Authorize the CALLER as the owner or a human co-admin only (least privilege).
  -- Rotation is owner-browser driven after a revoke; there is no agent-initiated
  -- rotation path, so active agents are recipients, never callers. Never inferred
  -- from wrapped_data_keys (the mutable artifact rotation removes).
  IF NOT (
    v_caller = v_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_admins wa
      WHERE wa.owner_user_id = v_owner AND wa.admin_user_id = v_caller
    )
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not the owner or a co-admin of this key''s scope'
      USING ERRCODE = '42501';
  END IF;

  -- The new key must be fresh: no existing ownership record and no existing
  -- envelopes, so a caller cannot append envelopes onto someone else's key.
  IF EXISTS (SELECT 1 FROM public.data_keys WHERE data_key_id = p_new_data_key_id)
     OR EXISTS (SELECT 1 FROM public.wrapped_data_keys WHERE data_key_id = p_new_data_key_id)
  THEN
    RAISE EXCEPTION 'p_new_data_key_id already exists; a rotation must mint a fresh key'
      USING ERRCODE = '42501';
  END IF;

  -- Every named recipient must be a current member of the owner scope at call time.
  -- Reject the whole call if any recipient is not currently legitimate.
  -- Never inferred from wrapped_data_keys (the mutable artifact rotation removes).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_envelopes) e
    WHERE (e->>'recipient_user_id')::UUID NOT IN (
      SELECT v_owner
      UNION
      SELECT wa.admin_user_id FROM public.workspace_admins wa
        WHERE wa.owner_user_id = v_owner
      UNION
      SELECT am.shadow_user_id FROM public.agent_members am
        WHERE am.owner_user_id = v_owner
          AND am.revoked_at IS NULL
          AND am.shadow_user_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'One or more recipients are not current members of this key''s scope'
      USING ERRCODE = '42501';
  END IF;

  -- The owner must be among the named recipients, else the rotation mints a new
  -- key with no owner envelope, a self-inflicted lockout. Reject otherwise.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_envelopes) e
    WHERE (e->>'recipient_user_id')::UUID = v_owner
  ) THEN
    RAISE EXCEPTION 'The key owner must be among the named recipients'
      USING ERRCODE = '42501';
  END IF;

  -- Register the new key ownership before inserting envelopes (FK + audit).
  INSERT INTO public.data_keys (data_key_id, owner_user_id)
  VALUES (p_new_data_key_id, v_owner);

  -- Insert the new envelopes with grant_sig and grant_sig_alg.
  INSERT INTO public.wrapped_data_keys (
    data_key_id,
    recipient_user_id,
    wrapped_ciphertext,
    algorithm,
    grant_sig,
    grant_sig_alg
  )
  SELECT
    p_new_data_key_id,
    (e->>'recipient_user_id')::UUID,
    e->>'wrapped_ciphertext',
    coalesce(e->>'algorithm', 'hybrid-x25519-mlkem768'),
    e->>'grant_sig',
    coalesce(e->>'grant_sig_alg', 'ml-dsa-65-v1')
  FROM jsonb_array_elements(p_envelopes) e;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Audit
  SELECT a.entry_id
  INTO v_audit_id
  FROM public.append_audit_entry(
    p_action          => 'agents.data_key_rotated',
    p_actor_user_id   => v_caller,
    p_actor_member_id => NULL,
    p_resource_type   => 'data_key',
    p_resource_id     => p_new_data_key_id::TEXT,
    p_reason          => p_reason,
    p_result          => 'ok'
  ) a;

  RETURN QUERY SELECT p_new_data_key_id, v_count, v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_data_key(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_data_key(UUID, UUID, JSONB, TEXT) TO authenticated;

COMMENT ON FUNCTION public.rotate_data_key IS
  'Atomic insert of new wrapped_data_keys envelopes + audit entry after a data key rotation. '
  'Authorizes the caller as the owner or workspace_admins only (least privilege; no agent-initiated path). '
  'Checks every named recipient is a current member of the owner scope (owner, workspace_admins, '
  'non-revoked agent_members) at call time, never old-key co-recipiency. '
  'Requires the owner among recipients. Fail-closed grant_sig pre-flight: refuses any batch missing '
  'a non-empty grant_sig before inserting any rows. Writes grant_sig and grant_sig_alg per envelope. '
  'Reconciles DL-0311 (current-membership authz) and DL-0619 (grant_sig). '
  'Supersedes 20260805100000 (old-key co-recipiency) and the function section removed from 20260727000000.';
