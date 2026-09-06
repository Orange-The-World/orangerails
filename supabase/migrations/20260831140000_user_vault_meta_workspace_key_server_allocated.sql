-- 20260831140000_user_vault_meta_workspace_key_server_allocated.sql
--
-- Mint public.user_vault_meta.workspace_key_id server side, and withdraw the
-- caller's privilege on that column entirely.
--
-- WHY
-- Ownership on every public.wrapped_data_keys policy is decided by the VALUE of
-- user_vault_meta.workspace_key_id. Before this migration an authenticated user
-- could choose that value on the first write: INSERT was not covered by the
-- write-once trigger, and NULL to anything was permitted on UPDATE. A co-admin who
-- legitimately reads a wrapped row learns the owner's data_key_id, claims it, and
-- can then DELETE every wrapped copy of the owner's data key. This is integrity and
-- availability, not confidentiality: no decryption becomes possible. It is permanent
-- destruction of another tenant's access to their own data.
--
-- THE RULING (OR-T0956, cryptography-engineer, 2026-08-31): server side allocation.
-- The caller must not be able to supply the value by any path. The alternative, a
-- first write constrained to a value the caller provably owns, was rejected because
-- there is nothing to prove: the client mints the key and the label, and under zero
-- knowledge the server never holds anything tying them together.
--
-- THE LATTICE, stated verbatim from the ruling. Every path that could set the column:
--   INSERT non-NULL          refused by the BEFORE INSERT trigger below, for everyone,
--                            including the definer.
--   UPDATE NULL to X         requires UPDATE(workspace_key_id), which after the
--                            column grants below only the table owner holds, so only
--                            public.allocate_workspace_key() can do it.
--   UPDATE X to Y            refused by trg_vault_workspace_key_write_once.
--   two rows the same value  refused by UNIQUE (workspace_key_id).
-- There is no fifth path.
--
-- PRE-BUILD CONFIRMATION, answered before any SQL was written, as OR-T0966 required.
-- Question: does the client DERIVE data_key_id from key material, or is it an opaque
-- random label? Read src/lib/co-admin.ts at ref=dev, lines 295 to 330. Line 298 is
--   workspaceKeyId = crypto.randomUUID();
-- It is an OPAQUE RANDOM LABEL. Nothing is derived from key material, and
-- src/lib/key-wrapping.ts line 200 says the same: "caller is responsible for
-- assigning data_key_id". So server minting with gen_random_uuid() breaks no
-- cryptographic binding, and the strictly worse fallback (an allocator accepting a
-- proposed id) was NOT built. The value is bound into the ML-DSA-65 grant signature
-- at co-admin.ts line 325, so the client must now read the value back from the
-- allocator BEFORE signing. That client change is a real breaking change and is
-- filed separately: until it ships, grantCoAdmin's UPDATE of this column fails with
-- a privilege error. Both projects hold zero rows, so no user is affected today.
--
-- SECOND CALL BEHAVIOUR of allocate_workspace_key(), decided and stated as required:
-- it RETURNS THE EXISTING VALUE rather than raising. Allocation is idempotent from
-- the client's point of view, so a retry after a dropped response cannot strand a
-- half-granted workspace. It raises only when the caller has no vault metadata row
-- at all, and when there is no authenticated session.
--
-- ALSO IN THIS MIGRATION: the assertions here pin trigger TIMING and EVENT through
-- pg_get_triggerdef rather than tgname alone. The assertion block in
-- 20260828214500 checked only that a trigger of that NAME existed, so it would have
-- passed just as happily after someone recreated the guard as an AFTER trigger,
-- which is to say it asserted nothing about the control.
--
-- KEYRING_EPOCH, a defect found while measuring and fixed here deliberately, not by
-- accident. The column grants below are rebuilt as "every column except
-- workspace_key_id", computed from the catalogue at apply time. That matters because
-- 20260831120000 added keyring_epoch to a table whose authenticated grants are
-- column level, and ADD COLUMN grants nothing to a role holding column level
-- privileges. The client was therefore unable to write the epoch at all, which the
-- OR-T0967 and OR-T0676 design requires it to do (nextEpoch = coalesce(watermark,0)
-- + 1). The control on the epoch is trg_keyring_epoch_guard, not the absence of a
-- privilege. Computing the list from the catalogue also means this file does not
-- depend on whether 20260831120000 has been applied yet.
--
-- IDEMPOTENT. CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE
-- TRIGGER, and revokes and grants that are naturally repeatable. A re-run is a no-op.
--
-- REVERSIBLE. To undo, in this order:
--   DROP TRIGGER IF EXISTS trg_vault_workspace_key_insert_null ON public.user_vault_meta;
--   DROP FUNCTION IF EXISTS public.enforce_vault_workspace_key_insert_null();
--   DROP FUNCTION IF EXISTS public.allocate_workspace_key();
--   GRANT INSERT (workspace_key_id), UPDATE (workspace_key_id)
--     ON public.user_vault_meta TO authenticated;
-- Safe while no workspace key has been allocated. After the first allocation the
-- undo re-opens the claim hole rather than restoring anything.
--
-- Refs: OR-T0966, OR-T0956, OR-T0805, OR-T0967, OR-T0676

BEGIN;

-- 1. The allocator. The only thing on this database that may set the column.
CREATE OR REPLACE FUNCTION public.allocate_workspace_key()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'allocate_workspace_key requires an authenticated session';
  END IF;

  UPDATE public.user_vault_meta
     SET workspace_key_id = gen_random_uuid()
   WHERE user_id = auth.uid()
     AND workspace_key_id IS NULL
  RETURNING workspace_key_id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT workspace_key_id INTO v_id
    FROM public.user_vault_meta
   WHERE user_id = auth.uid();

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no vault metadata row for this user; create the vault before allocating a workspace key';
  END IF;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.allocate_workspace_key() IS
  'Mints public.user_vault_meta.workspace_key_id for the calling user and returns it. Takes no argument on purpose: the caller may not propose a value by any path. A second call returns the value already allocated rather than raising, so a retry after a lost response is safe. OR-T0966, OR-T0956.';

REVOKE ALL ON FUNCTION public.allocate_workspace_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_workspace_key() FROM anon;
GRANT EXECUTE ON FUNCTION public.allocate_workspace_key() TO authenticated;

-- 2. Column privileges. This is the load bearing half. RLS decides which ROW,
--    column privileges decide which COLUMN, and the policies are left untouched.
REVOKE INSERT, UPDATE ON public.user_vault_meta FROM PUBLIC;
REVOKE INSERT, UPDATE ON public.user_vault_meta FROM anon;
REVOKE INSERT, UPDATE ON public.user_vault_meta FROM authenticated;
REVOKE INSERT (workspace_key_id), UPDATE (workspace_key_id) ON public.user_vault_meta FROM PUBLIC;
REVOKE INSERT (workspace_key_id), UPDATE (workspace_key_id) ON public.user_vault_meta FROM anon;
REVOKE INSERT (workspace_key_id), UPDATE (workspace_key_id) ON public.user_vault_meta FROM authenticated;

DO $grant$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.user_vault_meta'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attname <> 'workspace_key_id';

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'FAIL: no grantable columns found on public.user_vault_meta';
  END IF;

  EXECUTE format(
    'GRANT INSERT (%s), UPDATE (%s) ON public.user_vault_meta TO authenticated',
    v_cols, v_cols);
END $grant$;

-- 3. INSERT is always NULL, for every principal including the definer, so that
--    allocation is only ever an UPDATE from NULL and the lattice above is complete.
CREATE OR REPLACE FUNCTION public.enforce_vault_workspace_key_insert_null()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.workspace_key_id IS NOT NULL THEN
    RAISE EXCEPTION
      'user_vault_meta.workspace_key_id is allocated by the server: INSERT it as NULL and call public.allocate_workspace_key()';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_vault_workspace_key_insert_null() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_vault_workspace_key_insert_null() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_vault_workspace_key_insert_null() FROM authenticated;

DROP TRIGGER IF EXISTS trg_vault_workspace_key_insert_null ON public.user_vault_meta;
CREATE TRIGGER trg_vault_workspace_key_insert_null
  BEFORE INSERT ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_vault_workspace_key_insert_null();
ALTER TABLE public.user_vault_meta ENABLE ALWAYS TRIGGER trg_vault_workspace_key_insert_null;

-- 4. Assertions. A migration that applies is not evidence that a control exists.
--    Every property the ruling pins is asserted by name, and the two triggers are
--    pinned by their DEFINITION so that timing and event cannot be swapped under us.
DO $assert$
DECLARE
  v_def    text;
  v_secdef boolean;
  v_config text[];
BEGIN
  IF has_column_privilege('authenticated', 'public.user_vault_meta', 'workspace_key_id', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: authenticated still holds INSERT on user_vault_meta.workspace_key_id';
  END IF;
  IF has_column_privilege('authenticated', 'public.user_vault_meta', 'workspace_key_id', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL: authenticated still holds UPDATE on user_vault_meta.workspace_key_id';
  END IF;
  IF has_column_privilege('anon', 'public.user_vault_meta', 'workspace_key_id', 'INSERT')
     OR has_column_privilege('anon', 'public.user_vault_meta', 'workspace_key_id', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL: anon holds a write privilege on user_vault_meta.workspace_key_id';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'vault_salt', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'user_id', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: the re-grant removed a column the client legitimately writes';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.user_vault_meta'::regclass
     AND t.tgname  = 'trg_vault_workspace_key_insert_null';
  IF v_def IS NULL OR v_def NOT ILIKE '%BEFORE INSERT ON public.user_vault_meta%' THEN
    RAISE EXCEPTION 'FAIL: trg_vault_workspace_key_insert_null must be BEFORE INSERT, got %', coalesce(v_def, '<missing>');
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.user_vault_meta'::regclass
     AND t.tgname  = 'trg_vault_workspace_key_write_once';
  IF v_def IS NULL OR v_def NOT ILIKE '%BEFORE UPDATE OF workspace\_key\_id ON public.user\_vault\_meta%' THEN
    RAISE EXCEPTION 'FAIL: trg_vault_workspace_key_write_once must be BEFORE UPDATE OF workspace_key_id, got %', coalesce(v_def, '<missing>');
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'allocate_workspace_key' AND p.pronargs = 0;
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'FAIL: public.allocate_workspace_key() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'FAIL: public.allocate_workspace_key() must be SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT ILIKE '%search_path=%' THEN
    RAISE EXCEPTION 'FAIL: public.allocate_workspace_key() must pin search_path';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.allocate_workspace_key()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot execute allocate_workspace_key()';
  END IF;
  IF has_function_privilege('anon', 'public.allocate_workspace_key()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute allocate_workspace_key()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_vault_meta'::regclass
       AND conname  = 'user_vault_meta_workspace_key_id_key'
       AND contype  = 'u'
  ) THEN
    RAISE EXCEPTION 'FAIL: UNIQUE (workspace_key_id) is missing, so two rows could claim one key';
  END IF;

  RAISE NOTICE 'OR-T0966 ok: allocator, column privileges, insert-null guard, write-once guard and UNIQUE all in place';
END $assert$;

COMMIT;
