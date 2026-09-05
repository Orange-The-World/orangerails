-- 20260803000000_fix_append_audit_entry_alias.sql
--
-- Root cause: RETURNS TABLE(..., this_hash text, chain_height bigint)
-- declares OUT parameters whose names shadow the same-named columns in
-- public.audit_entries. plpgsql resolves bare identifiers as the nearest
-- scope binding, so:
--
--   SELECT this_hash INTO v_prev_hash
--   FROM public.audit_entries
--   ORDER BY chain_height DESC
--
-- is ambiguous (sqlstate 42702) and the function raises on EVERY invocation,
-- breaking the happy path of rotate_data_key.
--
-- Fix: add table alias 'ae' and qualify both references.
-- No signature change. No GRANT/REVOKE change (existing grants are preserved
-- by CREATE OR REPLACE).

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
  -- Alias 'ae' added to resolve ambiguity between the OUT parameter 'this_hash'
  -- (from RETURNS TABLE) and the column 'this_hash' in public.audit_entries.
  -- Same for 'chain_height' in the ORDER BY clause.
  SELECT ae.this_hash INTO v_prev_hash
  FROM public.audit_entries ae
  ORDER BY ae.chain_height DESC
  LIMIT 1
  FOR UPDATE;

  -- Genesis: 64 zeros if there is no previous entry.
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  -- Reserve a chain_height by inserting a placeholder and computing the hash from it.
  -- We pre-reserve the height via nextval on the BIGSERIAL sequence.
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

  v_this_hash := encode(
    digest(v_prev_hash || v_canonical, 'sha256'),
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
