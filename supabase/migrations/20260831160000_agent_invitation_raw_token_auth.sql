-- 20260831160000_agent_invitation_raw_token_auth.sql
--
-- WHY
-- The invitation token is the credential for redeeming an agent invitation.
-- Until this migration, complete_agent_invitation identified the invitation by
-- its row id and required no token at all, so the row's name was carrying the
-- job of the row's secret. An identifier is meant to be referenced: links,
-- error payloads, client state, request logs, support views. A credential is
-- meant never to be. This makes the token the credential for the write, which
-- it already was for the read.
--
-- The token arrives RAW and is hashed inside the function body. It is
-- deliberately not the stored hash: if the value on the wire equalled the
-- stored column, then reading the table would be enough to redeem, and hashing
-- at rest would buy nothing.
--
-- Ruling: OR-T0954. Build spec: OR-T0965.
--
-- WHAT THIS DOES
-- 1. Replaces complete_agent_invitation with the signature
--      complete_agent_invitation(p_token text, p_shadow_user_id uuid,
--                                p_identity_pubkey text, p_kem_pubkey text)
--    The invitation id argument is removed. token_hash is UNIQUE, so the token
--    identifies exactly one row, and a second predicate that can disagree with
--    the first adds nothing.
-- 2. Replaces peek_agent_invitation in the SAME migration: raw token in, hashed
--    in the body. Its return shape is unchanged. Splitting the two halves
--    across migrations would leave a window in which no client can satisfy
--    both.
-- 3. Gives one indistinguishable error for every rejected redemption:
--    malformed, unknown, expired, revoked, already redeemed. Neither the token
--    nor its digest is ever echoed. peek keeps its existing behaviour of
--    returning an empty result rather than saying why.
-- 4. Ensures a UNIQUE index on agent_invitation_tokens(token_hash) and on
--    agent_members(shadow_user_id), creating either only if no unique index on
--    that column already exists.
--
-- NOT DONE, ON PURPOSE
-- No constant time comparison, no rate limiting, no challenge response. The
-- token is full entropy and unstructured, so an equality probe exposes nothing
-- adaptively searchable and there is no low entropy guess to grind. No
-- transitional signature that still accepts the old id only call: that would
-- keep the weaker path live for the whole length of the transition.
--
-- HASHING
-- encode(sha256(convert_to(p_token, 'UTF8')), 'hex') gives 64 lowercase hex
-- characters, the exact shape already stored in token_hash. sha256() is a
-- built in since PostgreSQL 11, so this adds no extension dependency inside a
-- SECURITY DEFINER body. Probed live on both server versions in use
-- (17.6 and 15.8) before writing this file: same digest on both.
--
-- GRANTS ARE PRESERVED PER DATABASE, NOT REWRITTEN
-- Replacing a function drops its grants, and a newly created function inherits
-- whatever default privileges the database has, which is exactly how unwanted
-- PUBLIC and anon entries appear. So this migration captures the EXECUTE
-- grantees each function holds BEFORE the replace, revokes PUBLIC, anon,
-- authenticated and service_role from the new definition unconditionally, then
-- re-grants exactly the captured set. Roles that held nothing before hold
-- nothing after, on every database, and a post condition fails the transaction
-- if the end state differs from the captured state. A hard coded grant list
-- would either widen one deployment or break another, because this surface is
-- exposed differently on different deployments.
-- One deliberate exception: a PUBLIC entry is never restored. If a database
-- had no explicit grants on these functions at all, the end state is the owner
-- only.
--
-- WIRE FORMAT CHANGE, AND WHY IT IS SAFE TO MAKE NOW
-- Callers must send the raw token where they previously sent the invitation id
-- or the token hash. An invitation minted before this change cannot be
-- completed after it, by design. Counted live 2026-08-31 immediately before
-- writing this file, on every database this migration reaches: zero live
-- invitations (redeemed_at IS NULL, revoked_at IS NULL, expires_at in the
-- future) and zero rows in agent_invitation_tokens. Nothing has to be
-- re-minted.
--
-- REVERSIBILITY
-- No row is read or written. Nothing is dropped except the two function
-- definitions, and the previous definitions are recoverable from migrations
-- 20260521020000 (complete) and 20260520030000 (peek). The undo is written at
-- the bottom of this file for reference. Both tables are empty on every
-- target, so the two unique indexes take no meaningful lock.
--
-- IDEMPOTENCY
-- DROP ... IF EXISTS covers both the old and the new signature, the indexes are
-- created only when absent, and grant restoration is driven by what is actually
-- present rather than by a fixed list. A re-run reaches the same end state.

-- ---------------------------------------------------------------------------
-- 1. Capture the EXECUTE grants that exist right now, before anything is
--    dropped. PUBLIC has no row in pg_roles, so it is captured by nobody and
--    is never restored, which is intentional.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE agent_invite_prior_grants AS
SELECT p.proname::text AS proname,
       r.rolname::text AS grantee
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a
  JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public'
   AND p.proname IN ('complete_agent_invitation', 'peek_agent_invitation')
   AND a.privilege_type = 'EXECUTE'
   AND r.rolname <> 'postgres';

-- ---------------------------------------------------------------------------
-- 2. Remove the old definitions. Both the old and the new signature are named
--    so a re-run is a no-op rather than a failure. A parameter rename cannot be
--    done with CREATE OR REPLACE, which is why peek is dropped too.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.complete_agent_invitation(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.complete_agent_invitation(TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.peek_agent_invitation(TEXT);

-- ---------------------------------------------------------------------------
-- 3. peek_agent_invitation: raw token in, hashed in the body. Read only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.peek_agent_invitation(p_token TEXT)
RETURNS TABLE (
  invitation_id   UUID,
  agent_member_id UUID,
  owner_user_id   UUID,
  expires_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $peek$
BEGIN
  -- A rejected token returns an empty result and says nothing about why: a
  -- malformed token, an unknown one, an expired one and a redeemed one are all
  -- the same answer.
  IF p_token IS NULL
     OR length(p_token) < 43
     OR length(p_token) > 512
     OR p_token !~ '^[A-Za-z0-9_=-]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id,
         t.agent_member_id,
         t.owner_user_id,
         t.expires_at
    FROM public.agent_invitation_tokens t
   WHERE t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     AND t.redeemed_at IS NULL
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
   LIMIT 1;
END;
$peek$;

COMMENT ON FUNCTION public.peek_agent_invitation(TEXT) IS
  'Read only invitation lookup. Takes the RAW invitation token and hashes it in the body; never takes the stored hash. Returns nothing for a token that is malformed, unknown, expired, revoked or already redeemed, without distinguishing between them.';

-- ---------------------------------------------------------------------------
-- 4. complete_agent_invitation: the token is the credential for the write.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.complete_agent_invitation(
  p_token           TEXT,
  p_shadow_user_id  UUID,
  p_identity_pubkey TEXT,
  p_kem_pubkey      TEXT
)
RETURNS TABLE (
  agent_member_id UUID,
  owner_user_id   UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $complete$
DECLARE
  v_agent_member_id UUID;
  v_owner_user_id   UUID;
  v_invitation_id   UUID;
  v_token_hash      TEXT;
BEGIN
  -- Shape checks on the caller supplied public keys. These describe the
  -- argument, not the invitation, so they keep their own messages.
  IF p_identity_pubkey IS NULL OR length(p_identity_pubkey) < 40 OR length(p_identity_pubkey) > 1024 THEN
    RAISE EXCEPTION 'identity_pubkey missing or invalid length';
  END IF;
  IF p_kem_pubkey IS NULL OR length(p_kem_pubkey) < 40 OR length(p_kem_pubkey) > 4096 THEN
    RAISE EXCEPTION 'kem_pubkey missing or invalid length';
  END IF;
  IF p_identity_pubkey !~ '^[A-Za-z0-9+/=_-]+$' THEN
    RAISE EXCEPTION 'identity_pubkey is not valid base64';
  END IF;
  IF p_kem_pubkey !~ '^[A-Za-z0-9+/=_-]+$' THEN
    RAISE EXCEPTION 'kem_pubkey is not valid base64';
  END IF;
  IF p_shadow_user_id IS NULL THEN
    RAISE EXCEPTION 'shadow_user_id is required';
  END IF;

  -- From here down every failure raises the SAME message, so a caller cannot
  -- tell a malformed token from an unknown, expired, revoked or already
  -- redeemed one. The token and its digest are never included in an error.
  IF p_token IS NULL
     OR length(p_token) < 43
     OR length(p_token) > 512
     OR p_token !~ '^[A-Za-z0-9_=-]+$' THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  v_token_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  SELECT t.id, t.agent_member_id, t.owner_user_id
    INTO v_invitation_id, v_agent_member_id, v_owner_user_id
    FROM public.agent_invitation_tokens t
   WHERE t.token_hash = v_token_hash
     AND t.redeemed_at IS NULL
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
   FOR UPDATE;

  IF v_agent_member_id IS NULL THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  UPDATE public.agent_members
     SET shadow_user_id   = p_shadow_user_id,
         identity_pubkey  = p_identity_pubkey,
         kem_pubkey       = p_kem_pubkey,
         activated_at     = now(),
         last_activity_at = now()
   WHERE id = v_agent_member_id
     AND activated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  UPDATE public.agent_invitation_tokens
     SET redeemed_at = now()
   WHERE id = v_invitation_id;

  -- Audit attributed to the new agent itself (it has just become a member)
  PERFORM public.append_audit_entry(
    p_action          => 'agents.invite_redeemed',
    p_actor_user_id   => p_shadow_user_id,
    p_actor_member_id => v_agent_member_id,
    p_resource_type   => 'agent_member',
    p_resource_id     => v_agent_member_id::TEXT,
    p_result          => 'ok'
  );

  RETURN QUERY SELECT v_agent_member_id, v_owner_user_id;
END;
$complete$;

COMMENT ON FUNCTION public.complete_agent_invitation(TEXT, UUID, TEXT, TEXT) IS
  'Redeems an agent invitation. Authenticates on the RAW invitation token, hashed in the body and matched against token_hash; never takes the invitation id or the stored hash. Every rejected redemption raises one indistinguishable error.';

-- ---------------------------------------------------------------------------
-- 5. Restore the grants captured in step 1, and nothing else.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE
  v_sig     TEXT;
  v_proname TEXT;
  v_role    TEXT;
  v_sigs    TEXT[] := ARRAY[
    'public.complete_agent_invitation(text,uuid,text,text)',
    'public.peek_agent_invitation(text)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_proname := split_part(split_part(v_sig, '.', 2), '(', 1);

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_sig);

    FOR v_role IN
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_sig, v_role);
    END LOOP;

    FOR v_role IN
      SELECT DISTINCT g.grantee
        FROM agent_invite_prior_grants g
       WHERE g.proname = v_proname
         AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = g.grantee)
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_sig, v_role);
      RAISE NOTICE '[invite-token-auth] restored EXECUTE on % to %', v_sig, v_role;
    END LOOP;
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 6. Uniqueness the new lookup depends on, and the defence in depth the ruling
--    asked for. Created only when no unique index on that column exists, so a
--    database that already has one under a different name does not gain a
--    duplicate.
-- ---------------------------------------------------------------------------
DO $indexes$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'agent_invitation_tokens'
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) LIKE '%(token_hash)%'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX agent_invitation_tokens_token_hash_key ON public.agent_invitation_tokens (token_hash)';
    RAISE NOTICE '[invite-token-auth] created unique index on agent_invitation_tokens(token_hash)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'agent_members'
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) LIKE '%(shadow_user_id)%'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX agent_members_shadow_user_id_key ON public.agent_members (shadow_user_id)';
    RAISE NOTICE '[invite-token-auth] created unique index on agent_members(shadow_user_id)';
  END IF;
END
$indexes$;

-- ---------------------------------------------------------------------------
-- 7. Post conditions. Any failure here fails the whole migration.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_proname  TEXT;
  v_expected TEXT[];
  v_actual   TEXT[];
  v_public   TEXT;
BEGIN
  IF to_regprocedure('public.complete_agent_invitation(uuid,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '[invite-token-auth] the id only signature of complete_agent_invitation still exists';
  END IF;

  IF to_regprocedure('public.complete_agent_invitation(text,uuid,text,text)') IS NULL
     OR to_regprocedure('public.peek_agent_invitation(text)') IS NULL THEN
    RAISE EXCEPTION '[invite-token-auth] a replacement function is missing';
  END IF;

  FOREACH v_proname IN ARRAY ARRAY['complete_agent_invitation', 'peek_agent_invitation'] LOOP
    SELECT coalesce(array_agg(DISTINCT g.grantee ORDER BY g.grantee), ARRAY[]::text[])
      INTO v_expected
      FROM agent_invite_prior_grants g
     WHERE g.proname = v_proname
       AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = g.grantee);

    SELECT coalesce(array_agg(DISTINCT r.rolname::text ORDER BY r.rolname::text), ARRAY[]::text[])
      INTO v_actual
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public'
       AND p.proname = v_proname
       AND a.privilege_type = 'EXECUTE'
       AND r.rolname <> 'postgres';

    IF v_expected IS DISTINCT FROM v_actual THEN
      RAISE EXCEPTION '[invite-token-auth] EXECUTE grants on % changed: before %, after %',
        v_proname, v_expected, v_actual;
    END IF;

    -- Same predicate the migration apply gate uses for a bare PUBLIC entry.
    SELECT string_agg(ace::text, ', ')
      INTO v_public
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL unnest(coalesce(p.proacl, '{}'::aclitem[])) AS ace
     WHERE n.nspname = 'public'
       AND p.proname = v_proname
       AND ace::text LIKE '=%';

    IF v_public IS NOT NULL THEN
      RAISE EXCEPTION '[invite-token-auth] % carries a bare PUBLIC EXECUTE entry: %', v_proname, v_public;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'agent_invitation_tokens'
       AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '%(token_hash)%'
  ) THEN
    RAISE EXCEPTION '[invite-token-auth] agent_invitation_tokens(token_hash) is not unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'agent_members'
       AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '%(shadow_user_id)%'
  ) THEN
    RAISE EXCEPTION '[invite-token-auth] agent_members(shadow_user_id) is not unique';
  END IF;

  RAISE NOTICE '[invite-token-auth] post conditions passed';
END
$verify$;

DROP TABLE agent_invite_prior_grants;

-- ---------------------------------------------------------------------------
-- ROLLBACK (run by hand only, and only with the reason written down: this
-- restores a redemption path that authenticates on an identifier)
--
-- Re-apply the function bodies from 20260521020000 (complete_agent_invitation)
-- and 20260520030000 (peek_agent_invitation), then:
--   DROP FUNCTION IF EXISTS public.complete_agent_invitation(TEXT, UUID, TEXT, TEXT);
-- Grants: re-issue whatever the target database held, which for the hosted
-- projects is
--   GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(UUID, UUID, TEXT, TEXT) TO service_role;
--   GRANT EXECUTE ON FUNCTION public.peek_agent_invitation(TEXT) TO service_role;
-- The two unique indexes are left in place on rollback; they are correct
-- regardless of which redemption path is live.
-- ---------------------------------------------------------------------------
