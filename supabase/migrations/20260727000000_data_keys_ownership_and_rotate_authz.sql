-- ============================================================
-- data_keys ownership record + rotate_data_key current-membership authz
-- ============================================================
-- Security fix: rotate_data_key authorization gap on the authenticated path.
--
-- Requirement (signed by CTO + Auditor in Security & Privacy):
--   The authorization predicate must check CURRENT membership at call time,
--   for BOTH the caller and every named recipient. It must never be inferred
--   from existing wrapped_data_keys rows: those are the mutable artifact a
--   rotation removes, so a just-removed member still co-holds the old key and
--   would pass an old-key co-recipiency check.
--
-- What "current member of an owner's scope" means, bound to the live schema:
--   * the owner            -> owner_user_id itself
--   * human co-admins      -> workspace_admins.admin_user_id (owner_user_id = owner)
--   * active agents        -> agent_members.shadow_user_id
--                             (owner_user_id = owner AND revoked_at IS NULL)
--   The agent recipient identity is shadow_user_id: revoke_agent_member deletes
--   wrapped_data_keys WHERE recipient_user_id = shadow_user_id, so that is the
--   verified mapping between an agent member and its envelope recipient id.
--
-- ZKA: data_keys(owner_user_id) is an ownership mapping, not key plaintext.
-- The envelope crypto model is unchanged; the server never sees a plaintext key.
--
-- Reversibility (down-path):
--   ALTER TABLE public.wrapped_data_keys DROP CONSTRAINT IF EXISTS wrapped_data_keys_data_key_id_fk;
--   DROP TABLE IF EXISTS public.data_keys;
--   then re-apply 20260521030000_rotate_data_key_fn.sql to restore the prior body.

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

-- ------------------------------------------------------------
-- 4. rotate_data_key rewrite: authorize on CURRENT membership
-- ------------------------------------------------------------
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

  -- Resolve the authoritative owner of the key being rotated out.
  SELECT owner_user_id INTO v_owner
  FROM public.data_keys
  WHERE data_key_id = p_old_data_key_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'p_old_data_key_id has no ownership record'
      USING ERRCODE = '42501';
  END IF;

  -- Authorize the CALLER as a current member of the owner's scope at call time.
  -- Never inferred from wrapped_data_keys (the mutable artifact rotation removes).
  IF NOT (
    v_caller = v_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_admins wa
      WHERE wa.owner_user_id = v_owner AND wa.admin_user_id = v_caller
    )
    OR EXISTS (
      SELECT 1 FROM public.agent_members am
      WHERE am.owner_user_id = v_owner
        AND am.shadow_user_id = v_caller
        AND am.revoked_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller is not a current member of this key''s scope'
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

  -- Every named recipient must be a current member of the owner's scope.
  -- Reject the whole call if any recipient is not currently legitimate.
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

  -- Register the new key's ownership before inserting its envelopes (FK + audit).
  INSERT INTO public.data_keys (data_key_id, owner_user_id)
  VALUES (p_new_data_key_id, v_owner);

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
  'Atomic insert of new wrapped_data_keys envelopes + audit entry after a data key rotation. Authorizes the caller and every named recipient against current membership at call time (owner, workspace_admins, non-revoked agent_members), never old-key co-recipiency. Registers the new key owner in data_keys.';
