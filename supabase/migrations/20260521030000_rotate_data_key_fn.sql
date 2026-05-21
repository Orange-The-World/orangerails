-- ============================================================
-- rotate_data_key — atomic insert of new wrapped envelopes for all recipients
-- ============================================================
-- See: https://wiki.abascal.ca/doc/11-browser-implementation-plan-milestones-14-18-react-side-xZjcl1w20r
-- Session: 2026-05-21-BIRCH
--
-- Called by the browser after a revoke event. The browser:
--   1. Reads all remaining members (humans + agents)
--   2. Generates a fresh data key in memory
--   3. Wraps the new data key for every remaining recipient's kem_pubkey
--   4. Calls this function with the array of new envelopes
--
-- This function then atomically:
--   - Inserts every new envelope into wrapped_data_keys
--   - Marks the old data_key_id as superseded (placeholder; v1 just
--     stamps the rotation in an audit entry for now — full superseded
--     tracking lands when historical-ciphertext re-encryption ships)
--   - Writes an audit_entries row attributing the rotation to the owner
--
-- INPUT shape for p_envelopes:
--   [{ "recipient_user_id": "uuid", "wrapped_ciphertext": "base64", "algorithm": "hybrid-x25519-mlkem768" }, ...]

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
  v_caller      UUID := auth.uid();
  v_count       INT  := 0;
  v_audit_id    UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no auth context';
  END IF;

  IF p_new_data_key_id IS NULL THEN
    RAISE EXCEPTION 'p_new_data_key_id is required';
  END IF;

  IF p_envelopes IS NULL OR jsonb_array_length(p_envelopes) = 0 THEN
    RAISE EXCEPTION 'p_envelopes must be a non-empty JSON array';
  END IF;

  -- Insert the new envelopes. Each row is keyed by (data_key_id, recipient_user_id).
  INSERT INTO public.wrapped_data_keys (
    data_key_id,
    recipient_user_id,
    wrapped_ciphertext,
    algorithm
  )
  SELECT
    p_new_data_key_id,
    (e->>'recipient_user_id')::UUID,
    e->>'wrapped_ciphertext',
    coalesce(e->>'algorithm', 'hybrid-x25519-mlkem768')
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
  'Atomic insert of new wrapped_data_keys envelopes + audit entry after a data key rotation. Called by the browser after revoke when remaining members need a fresh wrapped envelope.';
