-- 20260905130000_document_vault_meta_delete_guard_dependencies.sql
--
-- OR-T0776: record on the function itself the two things the Auditor found
-- while approving PR #940 (DEV-0299), so the next person to touch this guard
-- reads the dependency instead of rediscovering it.
--
-- public.enforce_vault_meta_no_direct_delete() allows a delete only at
-- pg_trigger_depth() > 1 with the owning auth.users row already gone, which is
-- true only inside the account removal cascade. The depth term is the brittle
-- half of that condition: it is what stops a direct delete of an orphaned row,
-- and it depends on account removal reaching this trigger at exactly that
-- nesting depth via Postgres's own FK cascade. Measured on dev 2026-08-28: a
-- plain client delete reaches the guard at depth 1, so pg_trigger_depth() > 0
-- would be unconditionally true inside any trigger and would drop the
-- orphaned-row check rather than simplify it. If account removal ever stops
-- using the auth.users FK cascade to reach this table, this guard will refuse
-- the cascade too and account deletion will fail closed on a customer-visible
-- compliance path. If that ever needs revisiting, the equivalent condition
-- "pg_trigger_depth() > 0 AND NOT EXISTS (...)" carries the same meaning with
-- no dependency on the exact depth.
--
-- The function is SECURITY INVOKER and reads auth.users. Measured 2026-08-28:
-- has_table_privilege('authenticated', 'auth.users', 'SELECT') is false on
-- both dev and production. The real account removal cascade runs as the
-- referencing table's owner, so the read succeeds there. Any other delete
-- path running as authenticated would fail on the auth.users permission error
-- before it ever reached this function's own RAISE, which is still fail
-- closed but points at the wrong thing in the error a caller would see.
--
-- Comment only. No behaviour change, and idempotent: COMMENT ON FUNCTION
-- replaces the whole comment on every run.

-- OUT-OF-ORDER-OK: comment-only migration (COMMENT ON FUNCTION), no schema or behavior change, and the target function's signature is unaffected by every migration currently ahead of it; safe to apply after any of them.
--
COMMENT ON FUNCTION public.enforce_vault_meta_no_direct_delete() IS
'Allows DELETE on user_vault_meta / customer_vault_meta only when
pg_trigger_depth() > 1 AND the owning auth.users row is already gone (true
only inside the account removal cascade); every other delete is refused. The
depth term is a recorded dependency, not incidental: it assumes account
removal reaches this trigger via the auth.users FK cascade at nesting depth 2
or more. If that path ever changes, this guard would start refusing the
cascade itself and account deletion would fail closed. SECURITY INVOKER; the
auth.users read succeeds only because the account removal cascade runs as the
referencing table owner, since authenticated holds no SELECT on auth.users on
dev or production. See OR-T0776.';
