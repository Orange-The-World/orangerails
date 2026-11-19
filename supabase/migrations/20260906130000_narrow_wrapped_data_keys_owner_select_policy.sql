-- Narrow the "wrapped_data_keys: owner can read their own wrapped keys"
-- permissive SELECT policy on public.wrapped_data_keys from TO public to
-- TO authenticated.
--
-- WHY THIS IS SEPARATE FROM 20260903001500 (narrow six SELECT policies from
-- public to authenticated). wrapped_data_keys carries TWO permissive SELECT
-- policies, not one: "Recipients can read their own wrapped data keys" (the
-- policy 20260903001500 named and narrowed) and
-- "wrapped_data_keys: owner can read their own wrapped keys" (a second,
-- differently named policy on the same table, added later by migration
-- 20260828174500, that the sibling file never mentioned and therefore never
-- touched). Measured on dev (fzwmnzmtqidumdqjdddz) before this file: the
-- owner-read policy carried polroles={0} (public) while the recipient-read
-- policy already carried polroles matching authenticated.
--
-- This left the owner-read policy violating the allow list invariant
-- asserted by 20260903040000 (stealth_and_vault_policy_role_allow_list),
-- whose check raises on any permissive SELECT policy on this table set that
-- is still addressed to public. That the live cluster carried a policy
-- violating that invariant is drift between the migration history and the
-- live database; this file closes the drift rather than explaining how it
-- happened.
--
-- USING CLAUSE, unchanged by this file:
--   EXISTS (SELECT 1 FROM user_vault_meta uvm
--            WHERE uvm.user_id = auth.uid()
--              AND uvm.workspace_key_id = wrapped_data_keys.data_key_id)
-- auth.uid() is null for an anonymous session, so the policy already failed
-- safe: an anonymous session read zero rows before this file and reads zero
-- rows after it. What this file removes is the policy applying to that
-- session at all, a property of the policy rather than of an expression a
-- later migration could rewrite.
--
-- PORTABILITY. Guarded on the table existing, for the same reason as
-- 20260903001500: the deploy applies migrations in order and stops on first
-- failure, so an unguarded ALTER POLICY on a cluster missing the table would
-- leave a partially applied batch. wrapped_data_keys is present on both dev
-- and production clusters, but the guard costs nothing and keeps this file
-- consistent with its siblings.
--
-- ROLLBACK:
--   ALTER POLICY "wrapped_data_keys: owner can read their own wrapped keys"
--     ON public.wrapped_data_keys TO public;

DO $$ BEGIN
  IF to_regclass('public.wrapped_data_keys') IS NULL THEN
    RAISE NOTICE 'wrapped_data_keys owner-read policy narrowing: public.wrapped_data_keys not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "wrapped_data_keys: owner can read their own wrapped keys" ON public.wrapped_data_keys TO authenticated';
  END IF;
END $$;

-- Self check. Confirms the policy is no longer addressed to public, is still
-- a permissive SELECT policy naming exactly the authenticated role, and that
-- service_role and or_agent_reader (if present) still bypass row level
-- security so narrowing this policy cannot hide rows from either.
DO $$
DECLARE
  polroles_now oid[];
  is_permissive boolean;
  cmd_now "char";
BEGIN
  IF to_regclass('public.wrapped_data_keys') IS NULL THEN
    RAISE NOTICE 'wrapped_data_keys owner-read policy narrowing: table not present, self check skipped';
    RETURN;
  END IF;

  SELECT p.polroles, p.polpermissive, p.polcmd
    INTO polroles_now, is_permissive, cmd_now
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'wrapped_data_keys'
     AND p.polname = 'wrapped_data_keys: owner can read their own wrapped keys';

  IF polroles_now IS NULL THEN
    RAISE EXCEPTION
      'wrapped_data_keys owner-read policy narrowing: policy "wrapped_data_keys: owner can read their own wrapped keys" not found on public.wrapped_data_keys after ALTER POLICY';
  END IF;

  IF polroles_now = '{0}'::oid[] THEN
    RAISE EXCEPTION
      'wrapped_data_keys owner-read policy narrowing: policy is still addressed to public after ALTER POLICY';
  END IF;

  IF polroles_now <> ARRAY['authenticated'::regrole::oid] THEN
    RAISE EXCEPTION
      'wrapped_data_keys owner-read policy narrowing: policy roles are %, expected exactly {authenticated}',
      polroles_now;
  END IF;

  IF NOT is_permissive OR cmd_now <> 'r' THEN
    RAISE EXCEPTION
      'wrapped_data_keys owner-read policy narrowing: policy is no longer a permissive SELECT policy (permissive=%, cmd=%)',
      is_permissive, cmd_now;
  END IF;

  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'service_role no longer bypasses row level security, so narrowing this policy can hide rows from the server side path';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader')
     AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'or_agent_reader') THEN
    RAISE EXCEPTION
      'or_agent_reader no longer bypasses row level security, so narrowing this policy can hide rows from the restricted read role';
  END IF;

  RAISE NOTICE 'wrapped_data_keys owner-read policy narrowing: end state verified, policy is addressed to authenticated only and remains a permissive SELECT policy.';
END $$;
