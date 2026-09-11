-- 20260831170000_allocate_workspace_key_writes_data_keys_ownership.sql
--
-- Make public.allocate_workspace_key() record the public.data_keys ownership row
-- for the key it mints, so that a co-admin grant can actually land.
--
-- THE PROBLEM IN ONE LINE. public.wrapped_data_keys.data_key_id carries a foreign
-- key to public.data_keys, and nothing wrote a data_keys row for a newly allocated
-- workspace key, so the first co-admin grant for any owner failed on the insert.
--
-- OBSERVED, not inferred. On dev, as an authenticated session holding a jwt sub,
-- the insert that grantCoAdmin performs returned:
--   ERROR 23503 insert or update on table "wrapped_data_keys" violates foreign key
--   constraint "wrapped_data_keys_data_key_id_fk"
--   DETAIL: Key is not present in table "data_keys".
-- Inserting the missing ownership row by hand and repeating the same insert made
-- it pass, so the ownership row was the only thing missing.
--
-- WHY NOTHING WROTE IT. 20260727000000_data_keys_ownership_and_rotate_authz created
-- data_keys as a table "written only by SECURITY DEFINER functions": row level
-- security on, and a SELECT only policy for the owner, so a client cannot write it
-- and should not be able to. Its backfill only covered workspace keys that already
-- existed, and was a verified no-op because both source tables were empty.
-- allocate_workspace_key(), added in 20260831140000, only UPDATEs user_vault_meta.
-- No trigger on user_vault_meta creates one. Only revoke_agent_member and
-- rotate_data_key mention data_keys anywhere in public, and neither creates an
-- ownership row for a newly allocated key. There was a writer for rotation and a
-- writer for backfill, and no writer for allocation.
--
-- WHY THE FIX IS IN THE ALLOCATOR AND NOT IN A TRIGGER. allocate_workspace_key() is
-- the single place the id comes into existence, and it is already SECURITY DEFINER,
-- so the key and its ownership record become atomic by construction: there is no
-- window in which a key exists with no owner. A trigger on user_vault_meta would
-- put one invariant in a third place, next to the insert-null guard and the
-- write-once guard, without closing that window any earlier.
--
-- BOTH PATHS, which is the part that is easy to get wrong. The function returns an
-- already allocated id without re-running the UPDATE. The ownership row is now
-- written on THAT path too, so an owner who allocated before this migration is not
-- left permanently unable to grant. The two paths are joined before the insert
-- rather than each carrying their own copy of it.
--
-- THE OWNERSHIP CHECK IS NOT DECORATION. ON CONFLICT DO NOTHING alone would happily
-- accept a pre-existing row belonging to somebody else and hand the caller an id it
-- does not own. The function therefore re-reads the row and raises if the owner is
-- not the caller, so that anomaly is loud instead of becoming a grant that fails
-- later somewhere less obvious.
--
-- BACKFILL. Every user_vault_meta row that already holds a non-NULL workspace_key_id
-- gets its ownership row here. Both projects hold zero rows today, so this is a
-- no-op in fact, and it is written anyway because the assertion below is only
-- meaningful if the backfill is real.
--
-- PRIVILEGES ARE RESTATED ON PURPOSE. CREATE OR REPLACE preserves the existing ACL,
-- but a first application on a database that does not yet have the function would
-- create it under that database's default privileges, and production's default
-- privileges for functions in public still include EXECUTE for anon (tracked
-- separately). Restating the revoke and the grant means this file cannot leave the
-- allocator reachable by anon on any database it is applied to, in any order.
--
-- IDEMPOTENT. CREATE OR REPLACE FUNCTION, an INSERT ... ON CONFLICT DO NOTHING
-- backfill, and revokes and grants that are naturally repeatable. A re-run is a
-- no-op. The function itself is idempotent per caller: a second call returns the
-- id already allocated and re-asserts the ownership row rather than raising.
--
-- REVERSIBLE. To undo, restore the previous body by re-applying the
-- CREATE OR REPLACE FUNCTION block from
-- 20260831140000_user_vault_meta_workspace_key_server_allocated.sql. The
-- data_keys rows written here are deliberately NOT removed by the undo: deleting an
-- ownership row breaks every wrapped_data_keys row that points at it, and leaving it
-- in place is harmless because the row is exactly what the rotation and backfill
-- writers would have produced.
--
-- SCOPE. Dev. Production carries the same foreign key and the same empty tables and
-- will need the same change; that promotion is a separate two party step and is not
-- this file.
--
-- Refs: OR-T1126, OR-T0966, OR-T0956, OR-T1114

BEGIN;

-- 1. The allocator, now writing the ownership record for the id it mints.
CREATE OR REPLACE FUNCTION public.allocate_workspace_key()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_id  uuid;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'allocate_workspace_key requires an authenticated session';
  END IF;

  UPDATE public.user_vault_meta
     SET workspace_key_id = gen_random_uuid()
   WHERE user_id = v_uid
     AND workspace_key_id IS NULL
  RETURNING workspace_key_id INTO v_id;

  IF v_id IS NULL THEN
    SELECT workspace_key_id INTO v_id
      FROM public.user_vault_meta
     WHERE user_id = v_uid;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'no vault metadata row for this user; create the vault before allocating a workspace key';
    END IF;
  END IF;

  INSERT INTO public.data_keys (data_key_id, owner_user_id)
  VALUES (v_id, v_uid)
  ON CONFLICT (data_key_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM public.data_keys d
     WHERE d.data_key_id   = v_id
       AND d.owner_user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'workspace key % is already recorded in public.data_keys under a different owner', v_id;
  END IF;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.allocate_workspace_key() IS
  'Mints public.user_vault_meta.workspace_key_id for the calling user, records the matching public.data_keys ownership row, and returns the id. Takes no argument on purpose: the caller may not propose a value by any path. A second call returns the value already allocated and re-asserts the ownership row rather than raising, so a retry after a lost response is safe. OR-T0966, OR-T0956, OR-T1126.';

REVOKE ALL ON FUNCTION public.allocate_workspace_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_workspace_key() FROM anon;
GRANT EXECUTE ON FUNCTION public.allocate_workspace_key() TO authenticated;

-- 2. Backfill: any workspace key allocated before this migration gets its owner
--    recorded now, so no existing owner is left unable to grant.
INSERT INTO public.data_keys (data_key_id, owner_user_id)
SELECT m.workspace_key_id, m.user_id
  FROM public.user_vault_meta m
 WHERE m.workspace_key_id IS NOT NULL
ON CONFLICT (data_key_id) DO NOTHING;

-- 3. Assertions. The orphan count is a real measurement of the defect this file
--    exists to fix: it goes red if any allocated workspace key still lacks its
--    ownership row, which is exactly the state that made a co-admin grant fail.
DO $assert$
DECLARE
  v_orphans bigint;
  v_def     text;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM public.user_vault_meta m
   WHERE m.workspace_key_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.data_keys d
        WHERE d.data_key_id   = m.workspace_key_id
          AND d.owner_user_id = m.user_id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'FAIL: % allocated workspace key(s) have no matching public.data_keys ownership row', v_orphans;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'allocate_workspace_key' AND p.pronargs = 0;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FAIL: public.allocate_workspace_key() is missing';
  END IF;
  IF v_def NOT ILIKE '%INSERT INTO public.data\_keys%' THEN
    RAISE EXCEPTION 'FAIL: allocate_workspace_key() does not write public.data_keys';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.allocate_workspace_key()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot execute allocate_workspace_key()';
  END IF;
  IF has_function_privilege('anon', 'public.allocate_workspace_key()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute allocate_workspace_key()';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.data_keys'::regclass) THEN
    RAISE EXCEPTION 'FAIL: row level security is off on public.data_keys';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.data_keys'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION 'FAIL: public.data_keys carries a non-SELECT policy; it must be written only by SECURITY DEFINER functions';
  END IF;

  RAISE NOTICE 'OR-T1126 ok: allocator writes the data_keys ownership row, no orphaned workspace keys remain';
END $assert$;

COMMIT;
