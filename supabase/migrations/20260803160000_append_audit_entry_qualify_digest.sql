-- 20260803160000_append_audit_entry_qualify_digest.sql
--
-- Follow-on to 20260803000000_fix_append_audit_entry_alias.sql.
--
-- That migration removed the 42702 ambiguous-column error, and it was
-- correct. It did not make the function work. Executing rotate_data_key end
-- to end on dev now gets past the ambiguous SELECT and fails one step later:
--
--   ERROR: 42883: function digest(text, unknown) does not exist
--
-- Cause: this function is SECURITY DEFINER with SET search_path = public.
-- pgcrypto is installed in the "extensions" schema, so a bare digest() call
-- cannot resolve when the function runs. This has been true since the
-- function was first created, which means the audit chain has never
-- successfully appended an entry.
--
-- Fix: qualify the call as extensions.digest(). Chosen over widening
-- search_path to "public, extensions" because a SECURITY DEFINER function
-- should keep the narrowest search_path it can.
--
-- No signature change. No GRANT/REVOKE change (CREATE OR REPLACE preserves
-- existing grants). The only difference from 20260803000000 is the one
-- qualified call.

CREATE OR REPLACE FUNCTION public.append_audit_entry(
  p_action            TEXT,
  p_actor_user_id     UUID DEFAULT NULL,
  p_actor_member_id   UUID DEFAULT NULL,
  p_resource_type     TEXT DEFAULT NULL,
  p_resource_id       TEXT DEFAULT NULL,
  p_before_ciphertext TEXT DEFAULT NULL,
  p_after_ciphertext  TEXT DEFAULT NULL,
  p_reason            TEXT DEFAULT NULL,
  p_client_ip         INET DEFAULT NULL,
  p_client_user_agent TEXT DEFAULT NULL,
  p_result            TEXT DEFAULT 'ok'
)
RETURNS TABLE(
  entry_id      UUID,
  chain_height  BIGINT,
  this_hash     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_hash    TEXT;
  v_chain_height BIGINT;
  v_created_at   TIMESTAMPTZ := now();
  v_canonical    TEXT;
  v_this_hash    TEXT;
  v_entry_id     UUID := gen_random_uuid();
BEGIN
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'action is required';
  END IF;

  -- Lock the latest entry to serialize chain extension.
  -- Without locking, two concurrent appends could compute the same prev_hash.
  -- Alias 'ae' resolves the ambiguity between the OUT parameters this_hash and
  -- chain_height (from RETURNS TABLE) and the same-named columns.
  SELECT ae.this_hash INTO v_prev_hash
  FROM public.audit_entries ae
  ORDER BY ae.chain_height DESC
  LIMIT 1
  FOR UPDATE;

  -- Genesis: 64 zeros if there is no previous entry.
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  -- Reserve a chain_height from the BIGSERIAL sequence before hashing, so the
  -- height is part of the hashed canonical bytes.
  v_chain_height := nextval(pg_get_serial_sequence('public.audit_entries', 'chain_height'));

  v_canonical := public.canonical_audit_bytes(
    v_chain_height,
    p_actor_user_id,
    p_actor_member_id,
    trim(p_action),
    p_resource_type,
    p_resource_id,
    p_before_ciphertext,
    p_after_ciphertext,
    p_reason,
    p_client_ip,
    p_client_user_agent,
    p_result,
    v_created_at
  );

  -- Schema-qualified: pgcrypto lives in "extensions", and this function's
  -- search_path is public only, so a bare digest() does not resolve.
  v_this_hash := encode(
    extensions.digest(v_prev_hash || v_canonical, 'sha256'),
    'hex'
  );

  INSERT INTO public.audit_entries (
    id,
    chain_height,
    actor_user_id,
    actor_member_id,
    action,
    resource_type,
    resource_id,
    before_ciphertext,
    after_ciphertext,
    reason,
    client_ip,
    client_user_agent,
    result,
    prev_hash,
    this_hash,
    created_at
  ) VALUES (
    v_entry_id,
    v_chain_height,
    p_actor_user_id,
    p_actor_member_id,
    trim(p_action),
    p_resource_type,
    p_resource_id,
    p_before_ciphertext,
    p_after_ciphertext,
    p_reason,
    p_client_ip,
    p_client_user_agent,
    p_result,
    v_prev_hash,
    v_this_hash,
    v_created_at
  );

  RETURN QUERY SELECT v_entry_id, v_chain_height, v_this_hash;
END;
$$;
