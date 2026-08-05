-- ============================================================
-- DL-0619: grant_sig column on wrapped_data_keys
--          + rotate_data_key function update
-- ============================================================
-- grant_sig stores the admin's ML-DSA-65 signature over a
-- canonical envelope payload, binding: data_key_id,
-- recipient_user_id, wrapped_ciphertext (or its hash),
-- algorithm, granting admin user id, and a fixed
-- domain-separation prefix. Produced client-side, verified
-- at consume time. The server never derives or reads the key.
--
-- Idempotency:
--   ADD COLUMN IF NOT EXISTS is a no-op on dev (column already
--   present as text NOT NULL from out-of-band apply).
--   SET NOT NULL is a no-op on dev (already NOT NULL).
--   Both targets have 0 rows so no backfill is required.
--
-- Session: 2026-08-05-DL-0619

-- Step 1: add column (nullable first for IF NOT EXISTS idempotency)
ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS grant_sig text;

-- Step 2: enforce NOT NULL (idempotent; safe with 0 rows on both targets)
ALTER TABLE public.wrapped_data_keys
  ALTER COLUMN grant_sig SET NOT NULL;

-- Step 3: update rotate_data_key to accept and persist grant_sig
-- ============================================================
-- INPUT shape for p_envelopes (updated):
--   [{
--     "recipient_user_id": "uuid",
--     "wrapped_ciphertext": "base64",
--     "algorithm": "hybrid-x25519-mlkem768",
--     "grant_sig": "base64"
--   }, ...]
-- The NOT NULL constraint on grant_sig rejects envelopes that
-- omit the field at the database layer.

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

  IF p_old_data_key_id IS NULL THEN
    RAISE EXCEPTION 'p_old_data_key_id is required';
  END IF;

  IF p_new_data_key_id IS NULL THEN
    RAISE EXCEPTION 'p_new_data_key_id is required';
  END IF;

  -- Ownership check (Audit H1, 2026-05-21).
  -- Without this, any signed-in user could call rotate_data_key with
  -- any old/new key UUIDs and insert wrapped envelopes for arbitrary
  -- recipient_user_ids. We anchor authorisation on the OLD data key:
  -- the caller must currently hold a wrapped envelope for it (i.e.,
  -- they are a legitimate recipient of the key being rotated out).
  IF NOT EXISTS (
    SELECT 1
    FROM public.wrapped_data_keys
    WHERE data_key_id = p_old_data_key_id
      AND recipient_user_id = v_caller
  ) THEN
    RAISE EXCEPTION 'data_key not found or caller is not a recipient of p_old_data_key_id'
      USING ERRCODE = '42501';
  END IF;

  IF p_envelopes IS NULL OR jsonb_array_length(p_envelopes) = 0 THEN
    RAISE EXCEPTION 'p_envelopes must be a non-empty JSON array';
  END IF;

  -- Insert the new envelopes. Each row is keyed by (data_key_id, recipient_user_id).
  -- grant_sig is required per NOT NULL constraint; missing field raises at insert.
  INSERT INTO public.wrapped_data_keys (
    data_key_id,
    recipient_user_id,
    wrapped_ciphertext,
    algorithm,
    grant_sig
  )
  SELECT
    p_new_data_key_id,
    (e->>'recipient_user_id')::UUID,
    e->>'wrapped_ciphertext',
    coalesce(e->>'algorithm', 'hybrid-x25519-mlkem768'),
    e->>'grant_sig'
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
  'Atomic insert of new wrapped_data_keys envelopes + audit entry after a data key rotation. Called by the browser after revoke when remaining members need a fresh wrapped envelope. Each envelope must include grant_sig: the admin ML-DSA-65 signature over the canonical envelope payload (data_key_id, recipient_user_id, wrapped_ciphertext, algorithm, granting admin user id, domain prefix).';
