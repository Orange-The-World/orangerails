-- ============================================================
-- DL-0619 corrective: rotate_data_key writes grant_sig,
-- CHECK on non-empty grant_sig, record grant_sig_alg per row.
-- 2026-08-05
-- ============================================================

-- 1. Ensure grant_sig column exists on all environments. Prod does not have
--    it; dev got it out of band with no migration. ADD COLUMN IF NOT EXISTS
--    is re-runnable. SET NOT NULL is safe: both dev and prod have 0 rows
--    (verified 2026-08-05), so no backfill is needed.
ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS grant_sig TEXT;
ALTER TABLE public.wrapped_data_keys
  ALTER COLUMN grant_sig SET NOT NULL;

-- 2. Add grant_sig_alg column to record the signing scheme per row.
--    Default 'ml-dsa-65-v1' is the only scheme in use today.
--    Stored per-row so a future algorithm migration can identify old rows.
ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS grant_sig_alg TEXT NOT NULL DEFAULT 'ml-dsa-65-v1';

-- 3. Enforce that grant_sig is never empty.
--    NOT NULL was set in step 1; this adds a named non-empty check for
--    clear error messages. Wrapped in a DO block: ADD CONSTRAINT has no
--    IF NOT EXISTS, so a plain ALTER would error on re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wrapped_data_keys'::regclass
      AND conname = 'wrapped_data_keys_grant_sig_nonempty'
  ) THEN
    ALTER TABLE public.wrapped_data_keys
      ADD CONSTRAINT wrapped_data_keys_grant_sig_nonempty
        CHECK (grant_sig <> '');
  END IF;
END;
$$;

-- 4. Replace rotate_data_key to require and write grant_sig + grant_sig_alg
--    from each envelope. Pre-flight: refuse any batch missing a signature
--    before inserting a single row (fail-closed, same posture as
--    loadAdminSubkeysDirect on the client).
--
--    Updated envelope shape:
--      [{
--        "recipient_user_id": "uuid",
--        "wrapped_ciphertext": "base64",
--        "algorithm":     "hybrid-x25519-mlkem768",  -- optional, default as before
--        "grant_sig":     "base64-ml-dsa-65-sig",    -- REQUIRED
--        "grant_sig_alg": "ml-dsa-65-v1"             -- optional, default 'ml-dsa-65-v1'
--      }, ...]
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
  -- This check runs before any write so the function is fail-closed:
  -- a caller that omits signatures on even one envelope gets a clean
  -- error and zero rows inserted.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_envelopes) e
    WHERE coalesce(e->>'grant_sig', '') = ''
  ) THEN
    RAISE EXCEPTION 'Every envelope must carry a non-empty grant_sig; refusing to rotate unsigned'
      USING ERRCODE = '23514';
  END IF;

  SELECT owner_user_id INTO v_owner
  FROM public.data_keys
  WHERE data_key_id = p_old_data_key_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'p_old_data_key_id has no ownership record'
      USING ERRCODE = '42501';
  END IF;

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

  IF EXISTS (SELECT 1 FROM public.data_keys WHERE data_key_id = p_new_data_key_id)
     OR EXISTS (SELECT 1 FROM public.wrapped_data_keys WHERE data_key_id = p_new_data_key_id)
  THEN
    RAISE EXCEPTION 'p_new_data_key_id already exists; a rotation must mint a fresh key'
      USING ERRCODE = '42501';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_envelopes) e
    WHERE (e->>'recipient_user_id')::UUID = v_owner
  ) THEN
    RAISE EXCEPTION 'The key owner must be among the named recipients'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.data_keys (data_key_id, owner_user_id)
  VALUES (p_new_data_key_id, v_owner);

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
  'Each envelope must carry a grant_sig (ML-DSA-65 signature over member_user_id, '
  'workspace_key_id, wrapped_ciphertext) matching the owner''s sig pubkey. '
  'Pre-flight rejects any batch missing a signature before inserting any rows (fail-closed). '
  'Called by the browser after revoke when remaining members need a fresh wrapped envelope. '
  'DL-0619 corrective (2026-08-05): added grant_sig + grant_sig_alg writes, '
  'fail-closed pre-flight, CHECK on non-empty grant_sig.';

COMMENT ON COLUMN public.wrapped_data_keys.grant_sig_alg IS
  'Signing algorithm used for grant_sig. Currently always ml-dsa-65-v1. '
  'Stored per-row for future algorithm agility.';
