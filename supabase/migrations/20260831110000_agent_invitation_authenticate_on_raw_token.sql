-- ============================================================
-- Agent invitation redemption: authenticate on the RAW token
-- ============================================================
-- Ticket:  OR-T0965 (P0)
-- Ruling:  OR-T0954 (design), OR-T0988 (which principal calls these)
-- Related: OR-T0937 (self hosted anon grant), OR-T0701 / OR-T0717 /
--          OR-T0963 / OR-T1027 (the default privilege class this file
--          has to defend against)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- complete_agent_invitation authenticated on the invitation UUID alone.
-- Anyone who learned an unredeemed invitation id inside its 7 day window
-- could activate that agent member with THEIR OWN identity_pubkey and
-- kem_pubkey, making themselves a valid key wrap recipient for that agent.
-- Silent from the owner's side: nothing errors and nothing is logged as a
-- failure.
--
-- ------------------------------------------------------------
-- WHAT CHANGES
-- ------------------------------------------------------------
-- 1. complete_agent_invitation takes p_token text, the RAW token. The body
--    computes the sha256 digest and matches it against
--    agent_invitation_tokens.token_hash, alongside the existing
--    redeemed_at IS NULL, revoked_at IS NULL, expires_at > now()
--    predicates, FOR UPDATE.
-- 2. p_invitation_id is GONE from that signature. The token alone
--    identifies the row, and token_hash is UNIQUE.
-- 3. peek_agent_invitation changes the same way IN THIS SAME FILE: raw
--    token in, hashed in the body.
--
-- WHY THE RAW TOKEN AND NOT THE HASH. If the client sends the hash then
-- the stored column IS the credential, and anyone who can merely READ
-- agent_invitation_tokens can complete any live invitation. Hashing at
-- rest buys nothing when the wire value equals the stored value. Leaving
-- peek on the hash would keep the read side as a leak to credential path,
-- and splitting the two halves across two migrations would leave a window
-- in which no client can satisfy both.
--
-- NOT DONE, and deliberately not: constant time comparison, rate limiting,
-- challenge and response. The token is full entropy and unstructured, so
-- there is nothing adaptively searchable. Adding them would be cost with
-- no defence bought.
--
-- ------------------------------------------------------------
-- WHY DROP AND CREATE RATHER THAN CREATE OR REPLACE
-- ------------------------------------------------------------
-- complete_agent_invitation changes its argument TYPE list
-- (uuid,uuid,text,text becomes text,uuid,text,text) and
-- peek_agent_invitation changes an input parameter NAME (p_token_hash
-- becomes p_token, with the same text type). PostgreSQL permits neither
-- through CREATE OR REPLACE. Both are therefore DROP plus CREATE.
--
-- ------------------------------------------------------------
-- WHY EVERY GRANT IS RE-STATED, AND WHY THE anon GRANT IS CONDITIONAL
-- ------------------------------------------------------------
-- A dropped and recreated function is born with the pg_default_acl of the
-- CREATING ROLE, not with its old ACL. Migrations execute as postgres.
-- Read live from pg_default_acl on 2026-08-31, objtype f, schema public,
-- granted by postgres:
--
--   hosted prod  lcdicqalreskibdfxkzb : anon=X, authenticated=X, service_role=X
--   hosted dev   fzwmnzmtqidumdqjdddz : postgres=X, authenticated=X, service_role=X
--
-- So on production, creating a function IS granting anon EXECUTE on it.
-- Without the explicit REVOKE below, this file would silently hand anon
-- EXECUTE back on a key binding function. That is the same defect class
-- tracked on OR-T0701, OR-T0717, OR-T0963 and fixed at source by OR-T1027.
-- This file does not depend on that fix having landed.
--
-- The anon grant is CONDITIONAL rather than hard coded because the three
-- clusters legitimately disagree and must not be forced to agree here:
--
--   hosted dev, hosted prod : the caller is service_role through an edge
--                             function (ruled on OR-T0988). anon has held
--                             no EXECUTE on these since 20260721120000.
--   self hosted             : anon DOES hold EXECUTE and the OR-T0937
--                             ruling keeps it.
--
-- A hard coded grant would be wrong on two clusters out of three whichever
-- way it was written. So this file CAPTURES the EXECUTE grants actually in
-- force before the drop and restores exactly those afterwards. That is the
-- only formulation that is correct on every cluster, and it is stable on
-- re-run because the captured post state equals the intended state.
-- PUBLIC is never restored: it is revoked unconditionally and deliberately.
--
-- ------------------------------------------------------------
-- IDEMPOTENT
-- ------------------------------------------------------------
-- Safe to re-run. Both old signatures are dropped IF EXISTS, the capture
-- table is created IF NOT EXISTS and inserted ON CONFLICT DO NOTHING, and
-- the new functions are created unconditionally. A second run is a no-op
-- in effect. Hosted dev already carries this shape, applied out of band
-- with no migration file and no ledger row (that drift is the reason this
-- file exists at all); re-running it there is expected and harmless.
--
-- ------------------------------------------------------------
-- REVERSIBLE
-- ------------------------------------------------------------
-- Yes, mechanically: re-apply 20260521020000 (previous
-- complete_agent_invitation) and 20260520030000 (previous peek). Doing so
-- REOPENS the takeover primitive, so it is a rollback of last resort and
-- must not be done to unblock a deploy.
--
-- ------------------------------------------------------------
-- PRE-LAND COUNTS, read live 2026-08-31
-- live invitations = redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
-- ------------------------------------------------------------
--   hosted dev  fzwmnzmtqidumdqjdddz : 0 live, 0 rows total, agent_members 0
--   hosted prod lcdicqalreskibdfxkzb : 0 live, 0 rows total, agent_members 0
--   self hosted (container supabase-db) : 0 live (recorded on OR-T0965, 04:52 UTC)
--
-- Zero everywhere, so the OR-T0954 land outright rule applies and no
-- invitation has to be re-minted. Outstanding invitations minted under the
-- old scheme could NOT be completed after this change, by design; there
-- are none.
--
-- OPERATIONAL NOTE, read before applying to production. The five agent
-- edge functions (or-mcp, or-agent-invite-mint, or-agent-invite-redeem,
-- or-agent-token-refresh, or-agent-revoke) were retired from this repo per
-- CHANGELOG, yet remain deployed and ACTIVE on the hosted projects. Their
-- source is therefore not in the tree and cannot be updated alongside this
-- change. This migration changes the signature they call, so redemption
-- through the deployed or-agent-invite-redeem will fail until that function
-- is rebuilt. With zero agent_members and zero invitations on every
-- cluster, the blast radius of that today is nil, and leaving the takeover
-- primitive live on production to preserve an unused code path would be the
-- wrong trade. Recorded rather than glossed.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Preconditions. These are the invariants the new lookup relies on.
--    token_hash UNIQUE is what makes the token alone sufficient to
--    identify a row now that p_invitation_id is gone.
-- ------------------------------------------------------------
DO $precheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'agent_invitation_tokens'
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (token_hash)'
  ) THEN
    ALTER TABLE public.agent_invitation_tokens
      ADD CONSTRAINT agent_invitation_tokens_token_hash_key UNIQUE (token_hash);
    RAISE NOTICE 'OR-T0965: added missing UNIQUE (token_hash)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'agent_members'
       AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (shadow_user_id)'
  ) THEN
    ALTER TABLE public.agent_members
      ADD CONSTRAINT agent_members_shadow_user_id_key UNIQUE (shadow_user_id);
    RAISE NOTICE 'OR-T0965: added missing UNIQUE (shadow_user_id)';
  END IF;
END
$precheck$;

-- ------------------------------------------------------------
-- 1. Capture the EXECUTE grants in force BEFORE the drop.
--    Only anon and authenticated are captured. PUBLIC is never restored.
--    Grantee 0 in aclexplode is PUBLIC and is dropped by the pg_roles
--    join, which is the intended behaviour, not an oversight.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._or_t0965_acl_capture (
  proname text NOT NULL,
  rolname text NOT NULL,
  PRIMARY KEY (proname, rolname)
);

INSERT INTO public._or_t0965_acl_capture (proname, rolname)
SELECT DISTINCT p.proname, r.rolname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public'
   AND p.proname IN ('complete_agent_invitation', 'peek_agent_invitation')
   AND a.privilege_type = 'EXECUTE'
   AND r.rolname IN ('anon', 'authenticated')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 2. Drop every prior overload of both functions.
--    Named explicitly rather than by a catalogue loop so that an
--    unexpected extra overload is left behind and trips the assertions
--    at the end, instead of being silently swallowed.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.complete_agent_invitation(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.complete_agent_invitation(text, uuid, text, text);
DROP FUNCTION IF EXISTS public.peek_agent_invitation(text);

-- ------------------------------------------------------------
-- 3. peek_agent_invitation(p_token text)
--    Read only validation of a raw token. Returns nothing at all for a
--    malformed, unknown, expired, revoked or already redeemed token:
--    one indistinguishable outcome, no error text to differentiate on.
--    Never echoes the token or its digest.
-- ------------------------------------------------------------
CREATE FUNCTION public.peek_agent_invitation(p_token text)
RETURNS TABLE (
  invitation_id   uuid,
  agent_member_id uuid,
  owner_user_id   uuid,
  expires_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $peek$
BEGIN
  IF p_token IS NULL
     OR length(p_token) < 43
     OR length(p_token) > 512
     OR p_token !~ '^[A-Za-z0-9_=-]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id, t.agent_member_id, t.owner_user_id, t.expires_at
    FROM public.agent_invitation_tokens t
   WHERE t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     AND t.redeemed_at IS NULL
     AND t.revoked_at  IS NULL
     AND t.expires_at  > now()
   LIMIT 1;
END;
$peek$;

COMMENT ON FUNCTION public.peek_agent_invitation(text) IS
  'Validates a RAW invitation token and returns the invitation it names. '
  'The digest is computed inside the body: the caller never sends, and '
  'never needs to know, the stored token_hash. Returns zero rows for every '
  'failure mode so they cannot be told apart. OR-T0965.';

-- ------------------------------------------------------------
-- 4. complete_agent_invitation(p_token text, ...)
--    p_invitation_id is gone. The raw token is the whole credential and
--    the digest is computed here, never accepted from the caller.
--    Every invitation related failure raises the SAME message.
--    The three argument validation errors above it are about the CALLER'S
--    OWN inputs, not about the invitation, so they leak nothing about
--    whether a given token exists.
-- ------------------------------------------------------------
CREATE FUNCTION public.complete_agent_invitation(
  p_token           text,
  p_shadow_user_id  uuid,
  p_identity_pubkey text,
  p_kem_pubkey      text
)
RETURNS TABLE (
  agent_member_id uuid,
  owner_user_id   uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $complete$
DECLARE
  v_agent_member_id uuid;
  v_owner_user_id   uuid;
  v_invitation_id   uuid;
  v_token_hash      text;
BEGIN
  IF p_identity_pubkey IS NULL
     OR length(p_identity_pubkey) < 40
     OR length(p_identity_pubkey) > 1024 THEN
    RAISE EXCEPTION 'identity_pubkey missing or invalid length';
  END IF;
  IF p_kem_pubkey IS NULL
     OR length(p_kem_pubkey) < 40
     OR length(p_kem_pubkey) > 4096 THEN
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

  -- Malformed token: same message as unknown, expired, revoked or already
  -- redeemed. Deliberate.
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
   WHERE t.token_hash  = v_token_hash
     AND t.redeemed_at IS NULL
     AND t.revoked_at  IS NULL
     AND t.expires_at  > now()
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

  PERFORM public.append_audit_entry(
    p_action          => 'agents.invite_redeemed',
    p_actor_user_id   => p_shadow_user_id,
    p_actor_member_id => v_agent_member_id,
    p_resource_type   => 'agent_member',
    p_resource_id     => v_agent_member_id::text,
    p_result          => 'ok'
  );

  RETURN QUERY SELECT v_agent_member_id, v_owner_user_id;
END;
$complete$;

COMMENT ON FUNCTION public.complete_agent_invitation(text, uuid, text, text) IS
  'Redeems an invitation using the RAW token as the sole credential. The '
  'invitation id is NOT an argument: knowing it is not sufficient to bind '
  'keys to an agent member. Every invitation related failure raises one '
  'indistinguishable message. OR-T0965.';

-- ------------------------------------------------------------
-- 5. Grants, every one of them stated here and none inherited.
--    Revoke first, unconditionally, because a recreated function carries
--    the creating role's pg_default_acl and on hosted prod that includes
--    anon and authenticated.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.peek_agent_invitation(text)                          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_agent_invitation(text, uuid, text, text)    FROM PUBLIC;

DO $revoke_roles$
DECLARE
  v_role text;
  v_sig  text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      FOREACH v_sig IN ARRAY ARRAY[
        'public.peek_agent_invitation(text)',
        'public.complete_agent_invitation(text,uuid,text,text)'
      ]
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_sig, v_role);
      END LOOP;
    END IF;
  END LOOP;
END
$revoke_roles$;

GRANT EXECUTE ON FUNCTION public.peek_agent_invitation(text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(text, uuid, text, text) TO service_role;

-- Restore exactly the anon / authenticated grants that were in force
-- before the drop, and nothing else. On the hosted projects this loop
-- restores nothing, because nothing was there. On the self hosted cluster
-- it restores the anon grant the OR-T0937 ruling keeps.
DO $restore$
DECLARE
  r record;
  v_sig text;
BEGIN
  FOR r IN SELECT proname, rolname FROM public._or_t0965_acl_capture LOOP
    v_sig := CASE r.proname
               WHEN 'complete_agent_invitation' THEN 'public.complete_agent_invitation(text,uuid,text,text)'
               WHEN 'peek_agent_invitation'     THEN 'public.peek_agent_invitation(text)'
             END;
    IF v_sig IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname) THEN
      RAISE NOTICE 'OR-T0965: captured role % no longer exists, not restored', r.rolname;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_sig, r.rolname);
    RAISE NOTICE 'OR-T0965: restored EXECUTE on % to %', v_sig, r.rolname;
  END LOOP;
END
$restore$;

DROP TABLE public._or_t0965_acl_capture;

-- ------------------------------------------------------------
-- 6. Assertions. These pin SHAPE, not just existence, so that a later
--    edit that changes the shape trips this file rather than passing it.
--    A file whose assertions still pass after the fix is reverted is
--    asserting nothing.
-- ------------------------------------------------------------
DO $assert$
DECLARE
  n         integer;
  v_args    text;
  v_def     text;
  v_public  integer;
BEGIN
  -- exactly one overload of each, so no old signature survives
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'complete_agent_invitation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'OR-T0965 assert: expected exactly 1 complete_agent_invitation, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'peek_agent_invitation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'OR-T0965 assert: expected exactly 1 peek_agent_invitation, found %', n;
  END IF;

  -- complete: raw token first, invitation id gone
  SELECT pg_get_function_arguments(p.oid), pg_get_functiondef(p.oid)
    INTO v_args, v_def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'complete_agent_invitation';
  IF v_args NOT LIKE 'p_token text%' THEN
    RAISE EXCEPTION 'OR-T0965 assert: complete_agent_invitation first arg is not the raw token, got %', v_args;
  END IF;
  IF v_args LIKE '%p_invitation_id%' THEN
    RAISE EXCEPTION 'OR-T0965 assert: p_invitation_id is still in the signature, got %', v_args;
  END IF;
  IF position('sha256' IN v_def) = 0 THEN
    RAISE EXCEPTION 'OR-T0965 assert: complete_agent_invitation does not hash inside the body';
  END IF;
  IF position('token_hash  = v_token_hash' IN v_def) = 0
     AND position('token_hash = v_token_hash' IN v_def) = 0 THEN
    RAISE EXCEPTION 'OR-T0965 assert: complete_agent_invitation does not match on the in-body digest';
  END IF;

  -- peek: parameter is named p_token, not p_token_hash
  SELECT pg_get_function_arguments(p.oid), pg_get_functiondef(p.oid)
    INTO v_args, v_def
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'peek_agent_invitation';
  IF v_args <> 'p_token text' THEN
    RAISE EXCEPTION 'OR-T0965 assert: peek_agent_invitation args are %, expected p_token text', v_args;
  END IF;
  IF position('sha256' IN v_def) = 0 THEN
    RAISE EXCEPTION 'OR-T0965 assert: peek_agent_invitation does not hash inside the body';
  END IF;

  -- no PUBLIC execute on either, on any cluster
  SELECT count(*) INTO v_public
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE ns.nspname = 'public'
     AND p.proname IN ('complete_agent_invitation', 'peek_agent_invitation')
     AND a.privilege_type = 'EXECUTE'
     AND a.grantee = 0;
  IF v_public > 0 THEN
    RAISE EXCEPTION 'OR-T0965 assert: PUBLIC still holds EXECUTE on % of the two functions', v_public;
  END IF;

  -- service_role must be able to call both: this is the caller on the
  -- hosted projects per OR-T0988, so losing it breaks redemption outright
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    IF NOT has_function_privilege('service_role',
         'public.complete_agent_invitation(text,uuid,text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'OR-T0965 assert: service_role cannot execute complete_agent_invitation';
    END IF;
    IF NOT has_function_privilege('service_role',
         'public.peek_agent_invitation(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'OR-T0965 assert: service_role cannot execute peek_agent_invitation';
    END IF;
  END IF;

  -- the uniqueness the token-only lookup depends on
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname='public' AND t.relname='agent_invitation_tokens'
       AND c.contype='u' AND pg_get_constraintdef(c.oid)='UNIQUE (token_hash)'
  ) THEN
    RAISE EXCEPTION 'OR-T0965 assert: UNIQUE (token_hash) missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname='public' AND t.relname='agent_members'
       AND c.contype='u' AND pg_get_constraintdef(c.oid)='UNIQUE (shadow_user_id)'
  ) THEN
    RAISE EXCEPTION 'OR-T0965 assert: UNIQUE (shadow_user_id) missing';
  END IF;

  RAISE NOTICE 'OR-T0965: all assertions passed';
END
$assert$;

COMMIT;
