-- 20260905060000_vault_meta_delete_guard_comment.sql
--
-- Documentation only. No behavior change, no privilege change.
--
-- Records on the catalog itself the SECURITY INVOKER caveat the Auditor
-- raised while approving PR #940 (OR-T0776): this function reads auth.users
-- and only succeeds today because it runs nested inside the account removal
-- cascade, under the referencing table's owner. See migration
-- 20260828170000_fix_vault_meta_delete_guard.sql for the full measurement
-- this guard's condition rests on.

COMMENT ON FUNCTION public.enforce_vault_meta_no_direct_delete() IS
'BEFORE DELETE guard on public.user_vault_meta. Allows exactly one path: '
'nested inside the account removal cascade (pg_trigger_depth() > 1) once '
'the owning auth.users row is already gone. SECURITY INVOKER: it reads '
'auth.users, and has_table_privilege(''authenticated'', ''auth.users'', '
'''SELECT'') is FALSE on both dev and prod, so this only succeeds because '
'the real cascade runs it under the referencing table''s owner, not as '
'authenticated. Any other caller reaching this trigger would fail on the '
'auth.users read itself rather than on this function''s own RAISE message. '
'Still fail closed either way. See OR-T0776 and '
'20260828170000_fix_vault_meta_delete_guard.sql for the full reasoning.';

DO $do$
BEGIN
  IF (SELECT obj_description('public.enforce_vault_meta_no_direct_delete'::regproc, 'pg_proc')) IS NULL THEN
    RAISE EXCEPTION 'comment did not attach to public.enforce_vault_meta_no_direct_delete';
  END IF;
END;
$do$;
