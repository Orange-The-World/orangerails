-- Close the "grant is the wall, policy is the door" gap for the authenticated
-- role on four tables, the same argument OR-T1155 made for anon (PR #1038,
-- PR #1059). Nothing here is exploitable today: RLS is enabled on all four
-- and a command with no matching permissive policy affects zero rows for a
-- non-owner role. This closes the second control (the grant) so a future
-- policy add is not the ONLY thing standing between authenticated and a
-- write it was never meant to have. OR-T1251.
--
-- WHO ACTUALLY WRITES EACH TABLE, so the removal is not a guess:
--   customer_recovery_shares  client-side supabase-js insert as authenticated,
--                             backed by "Customers insert own recovery share"
--                             (INSERT), staff SELECT/UPDATE via is_staff().
--                             No DELETE policy anywhere. src has no direct
--                             write path for it beyond the signup flow that
--                             the INSERT policy covers.
--   opk_key_rotations         server-side only, via the service role client
--                             in supabase/functions/or-sync-key-register
--                             (auth.serviceClient.from('opk_key_rotations')
--                             .insert(...)). service_role bypasses RLS and
--                             its own grant, not this one. Zero RLS policies
--                             exist for authenticated on this table, so
--                             nothing a browser session does can reach it
--                             either way.
--   platform_key_audit        written from inside a SECURITY DEFINER
--                             function (or_create_platform_require_
--                             authenticated_caller.sql) under the function
--                             owner's privileges, not the caller's own table
--                             grant. Zero RLS policies exist here too.
--   vault_security_events     client-side supabase-js insert as authenticated
--                             (src/lib/audit.ts logSecurityEvent, called from
--                             src/routes/*.tsx and ApiTokensSection.tsx),
--                             backed by "Users can insert their own vault
--                             security events" and read by "...read their
--                             own...". No UPDATE or DELETE policy: an audit
--                             log whose subject can edit or delete their own
--                             rows is not an audit log.
--
-- Per-table decision, evidence-driven (a privilege with a policy behind it
-- stays, a privilege with none goes):
--   customer_recovery_shares  keep INSERT, SELECT, UPDATE (each has a policy)
--                             revoke DELETE (no policy, ever)
--   opk_key_rotations         revoke INSERT, SELECT, UPDATE, DELETE (zero
--                             policies; the grant is dead weight end to end)
--   platform_key_audit        revoke INSERT, SELECT, UPDATE, DELETE (zero
--                             policies; same as above)
--   vault_security_events     keep INSERT, SELECT (each has a policy)
--                             revoke UPDATE, DELETE (no policy for either)
--
-- Item 4 of OR-T1251 asks the same backed-or-not question of user_vault_meta
-- and customer_vault_meta, which carry authenticated = arw (INSERT, SELECT,
-- UPDATE, no DELETE). Read live: both have an INSERT, a SELECT and an UPDATE
-- policy for authenticated (Customers/Users own-row policies). All three
-- granted privileges are backed. RESULT: no privilege needs removing on
-- either table. Part 3 below asserts that state instead of changing it, so
-- the answer is recorded rather than only implied by an empty diff.
--
-- IDEMPOTENT. REVOKE is absolute, not relative: running this against a
-- database already in the target state changes nothing and the assertions
-- in part 4 then prove the state instead of failing. Each block is guarded
-- on to_regclass so a project missing one of these tables skips it with a
-- notice instead of failing the whole deploy on 42P01.
--
-- REVERSAL, spelled out. To put a table back exactly as it was:
--   GRANT DELETE ON TABLE public.customer_recovery_shares TO authenticated;
--   GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE public.opk_key_rotations TO authenticated;
--   GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE public.platform_key_audit TO authenticated;
--   GRANT UPDATE, DELETE ON TABLE public.vault_security_events TO authenticated;
--
-- IF AN ASSERTION IN PART 4 FIRES, read the message before changing anything:
--   "still holds" naming a table  -> this file did not do what it claims.
--   "no longer holds" naming customer_recovery_shares/vault_security_events
--       INSERT, SELECT or UPDATE  -> a live client write path is about to
--       break. Stop and do not promote this migration.
--   "user_vault_meta/customer_vault_meta privilege set changed" -> something
--       else touched these tables' grants since this file was written;
--       re-run the backed-or-not test rather than trusting this comment.

-- ---------------------------------------------------------------------------
-- PART 1: customer_recovery_shares and vault_security_events lose only the
-- unbacked privilege, the backed ones stay untouched.
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('public.customer_recovery_shares') is null then
    raise notice 'OR-T1251: public.customer_recovery_shares not present, skipped';
  else
    execute 'revoke delete on table public.customer_recovery_shares from authenticated';
  end if;
end $$;

do $$ begin
  if to_regclass('public.vault_security_events') is null then
    raise notice 'OR-T1251: public.vault_security_events not present, skipped';
  else
    execute 'revoke update, delete on table public.vault_security_events from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2: opk_key_rotations and platform_key_audit lose the whole grant.
-- Zero RLS policies exist on either table for authenticated, so none of the
-- four privileges is backed by anything.
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('public.opk_key_rotations') is null then
    raise notice 'OR-T1251: public.opk_key_rotations not present, skipped';
  else
    execute 'revoke insert, select, update, delete on table public.opk_key_rotations from authenticated';
  end if;
end $$;

do $$ begin
  if to_regclass('public.platform_key_audit') is null then
    raise notice 'OR-T1251: public.platform_key_audit not present, skipped';
  else
    execute 'revoke insert, select, update, delete on table public.platform_key_audit from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PART 3: nothing to revoke here. user_vault_meta and customer_vault_meta
-- carry only backed privileges. This block changes nothing; it exists so
-- part 4 has a fixed set of "must still equal exactly this" to assert
-- against, which is the recorded answer to OR-T1251 item 4.
-- ---------------------------------------------------------------------------

-- (intentionally no statements: the finding is "no change needed", asserted
-- below, not silently implied by an absent block)

-- ---------------------------------------------------------------------------
-- PART 4: assert the END STATE for every table this file touches or
-- examined, not just the ones it changed.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- A1. customer_recovery_shares: authenticated must hold exactly
  -- INSERT, SELECT, UPDATE and nothing else.
  if to_regclass('public.customer_recovery_shares') is not null then
    select string_agg(a.privilege_type, ', ' order by a.privilege_type)
      into v_bad
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
     where n.nspname = 'public' and c.relname = 'customer_recovery_shares'
       and c.relacl is not null and r.rolname = 'authenticated'
       and a.privilege_type not in ('INSERT', 'SELECT', 'UPDATE');
    if v_bad is not null then
      raise exception 'OR-T1251 FAILED: customer_recovery_shares still holds for authenticated: %', v_bad;
    end if;
  end if;

  -- A2. opk_key_rotations and platform_key_audit: authenticated must hold
  -- NOTHING.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public' and c.relname in ('opk_key_rotations', 'platform_key_audit')
     and c.relacl is not null and r.rolname = 'authenticated';
  if v_bad is not null then
    raise exception 'OR-T1251 FAILED: still holds a privilege for authenticated: %', v_bad;
  end if;

  -- A3. vault_security_events: authenticated must hold exactly INSERT,
  -- SELECT and nothing else.
  if to_regclass('public.vault_security_events') is not null then
    select string_agg(a.privilege_type, ', ' order by a.privilege_type)
      into v_bad
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
     where n.nspname = 'public' and c.relname = 'vault_security_events'
       and c.relacl is not null and r.rolname = 'authenticated'
       and a.privilege_type not in ('INSERT', 'SELECT');
    if v_bad is not null then
      raise exception 'OR-T1251 FAILED: vault_security_events still holds for authenticated: %', v_bad;
    end if;
  end if;

  -- A4 (over-revoke guard). The four tables in part 1 and part 2 must NOT
  -- have lost a privilege this file did not name. Recomputed independently
  -- of A1-A3 by checking the specific privileges that were meant to survive
  -- are still present, so a future edit that widens the revoke by accident
  -- is caught here rather than only by an app error later.
  if to_regclass('public.customer_recovery_shares') is not null then
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and c.relname = 'customer_recovery_shares'
        and c.relacl is not null and r.rolname = 'authenticated' and a.privilege_type = 'INSERT'
    ) then
      raise exception 'OR-T1251 FAILED (over-revoke): customer_recovery_shares lost INSERT for authenticated, signup path is broken';
    end if;
  end if;
  if to_regclass('public.vault_security_events') is not null then
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and c.relname = 'vault_security_events'
        and c.relacl is not null and r.rolname = 'authenticated' and a.privilege_type = 'INSERT'
    ) then
      raise exception 'OR-T1251 FAILED (over-revoke): vault_security_events lost INSERT for authenticated, audit logging is broken';
    end if;
  end if;

  -- A5. user_vault_meta / customer_vault_meta: item 4's answer was "no
  -- change needed" because every granted privilege is policy-backed. Assert
  -- the set is still exactly INSERT, SELECT, UPDATE so a silent drift from
  -- some other migration is caught rather than assumed away.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public' and c.relname in ('user_vault_meta', 'customer_vault_meta')
     and c.relacl is not null and r.rolname = 'authenticated'
     and a.privilege_type not in ('INSERT', 'SELECT', 'UPDATE');
  if v_bad is not null then
    raise exception 'OR-T1251 FAILED: user_vault_meta/customer_vault_meta privilege set changed, holds for authenticated: %', v_bad;
  end if;

  raise notice 'OR-T1251: end state verified. authenticated holds no unbacked privilege on customer_recovery_shares, opk_key_rotations, platform_key_audit or vault_security_events, and user_vault_meta/customer_vault_meta are unchanged at INSERT, SELECT, UPDATE.';
end $$;
