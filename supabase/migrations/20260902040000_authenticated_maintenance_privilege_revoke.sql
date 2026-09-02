-- Remove TRUNCATE, TRIGGER, REFERENCES and MAINTAIN from the logged-in role
-- (authenticated) across schema public, and close the default privilege that
-- hands them to every new table.
--
-- WHAT IS WRONG TODAY, AND ON WHICH CLUSTER.
-- The default privilege for TABLES created by postgres in schema public differs
-- between our two clusters. On one it reads
--     authenticated=arwdDxtm
-- and on the other it reads
--     authenticated=arwd
-- Every table created on the first therefore arrives granting the logged-in
-- role TRUNCATE, TRIGGER, REFERENCES and MAINTAIN in addition to the four data
-- commands. Measured with aclexplode over pg_class.relacl, 34 tables in public
-- carry all four on that cluster and zero tables carry any of them on the
-- other.
--
-- THIS RUNS IN THE OPPOSITE DIRECTION TO THE REST OF THIS WORKSTREAM, and that
-- is the whole reason it went unnoticed. Everywhere else the tighter cluster is
-- the one we are promoting towards. Here the cluster that would catch the
-- problem is the one that has it, so a promotion will never surface it and no
-- check on the tighter side will ever go red. Do not read this file as making
-- one cluster match a target taken from the other one in the usual direction.
--
-- WHY TRUNCATE IS THE ONE THAT MATTERS, and it is not one more entry in a list.
-- TRUNCATE IS NOT SUBJECT TO ROW LEVEL SECURITY. Every other write on these
-- tables is filtered by a policy that pins the row to the calling user. A
-- TRUNCATE is not filtered at all and removes every row belonging to every
-- user. So on that cluster, row level security is not the last line of defence
-- on 34 tables for that one command. TRIGGER is the second one worth naming: a
-- role holding TRIGGER on a table can attach a trigger to it.
--
-- WHAT IS NOT CLAIMED. PostgREST exposes tables, views and functions, and no
-- route was found by which a browser session issues a TRUNCATE. This is a
-- privilege that should not exist rather than a demonstrated path, and it must
-- not be described as anything stronger. Equally, the absence of a known route
-- is not a reason to leave it: an earlier migration in this tree already
-- revokes TRUNCATE from this role on one table, so the judgement that the
-- privilege is wrong was made then and has been applied one table at a time
-- since. This applies it to the rest.
--
-- REFERENCES, THE ONE THAT COULD PLAUSIBLY HAVE BEEN LOAD BEARING. A role
-- holding REFERENCES can create a foreign key that points at the table, so it
-- is the member of this set most likely to be relied on somewhere. Searched:
-- every GRANT to this role anywhere in the repository (one hit, and it is a
-- comment explaining that EXECUTE is deliberately NOT granted), every use of
-- the word references under supabase/ (seven hits, all prose in comments), and
-- every CREATE TRIGGER, ALTER TABLE ... ADD CONSTRAINT and TRUNCATE under
-- supabase/functions (none). Nothing in the tree depends on the logged-in role
-- holding any of the four. All table DDL in this product is authored as
-- migrations and applied as the owning role, never by a client session.
--
-- THE OTHER CLUSTER NEEDS NO CHANGE, and this file still runs there, correctly,
-- as a clean no-op. Its tables hold none of the four, so every REVOKE below
-- matches nothing; its default privilege already reads arwd, so the ALTER
-- DEFAULT PRIVILEGES statement removes nothing; and its end state already
-- satisfies the assertions. The absence of a separate step for it is not an
-- oversight. Recording that here matters because a future reader comparing the
-- two clusters will otherwise assume half the work is missing.
--
-- WHAT IS DELIBERATELY NOT TOUCHED.
--   SELECT, INSERT, UPDATE and DELETE for this role, which are load bearing on
--   every client path. Widening the scope to them turns a change that alters no
--   application behaviour into a risky one. Part 3 asserts they are still
--   present on a named sample.
--   The anonymous role, which is a separate concern with its own change.
--   service_role, which is the server side identity and is never exposed to a
--   browser.
--
-- WHY EVERY STATEMENT IS GUARDED ON THE TABLE EXISTING. The list was measured
-- on one cluster, and the two clusters do not hold the same set of tables. A
-- bare REVOKE on a table that is not present fails with 42P01 and would take
-- the whole deploy down. Each block therefore checks to_regclass first and
-- raises a notice when it skips, so a skip is visible in the deploy log instead
-- of silent. The list is written out literally, one block per table: it is a
-- measurement, not a query, and it must never become a loop over every table in
-- schema public, which would strip tables added since for reasons nobody has
-- checked.
--
-- IDEMPOTENT. REVOKE and ALTER DEFAULT PRIVILEGES are absolute rather than
-- relative, so running this against a database already in the target state
-- changes nothing and the assertions then prove the state instead of failing.
--
-- REVERSAL, spelled out rather than described. For each table in part 1:
--     GRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE public.<table> TO authenticated;
-- and for part 2:
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLES TO authenticated;
--
-- ---------------------------------------------------------------------------
-- PART 1: the 34 tables that hold the four maintenance privileges today.
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('public.adapter_requests') is null then raise notice 'authenticated maintenance sweep: public.adapter_requests not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.adapter_requests from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.agent_invitation_tokens') is null then raise notice 'authenticated maintenance sweep: public.agent_invitation_tokens not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.agent_invitation_tokens from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.agent_members') is null then raise notice 'authenticated maintenance sweep: public.agent_members not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.agent_members from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.audit_entries') is null then raise notice 'authenticated maintenance sweep: public.audit_entries not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.audit_entries from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.audit_events') is null then raise notice 'authenticated maintenance sweep: public.audit_events not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.audit_events from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.channel_state') is null then raise notice 'authenticated maintenance sweep: public.channel_state not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.channel_state from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.connections') is null then raise notice 'authenticated maintenance sweep: public.connections not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.connections from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.customer_recovery_shares') is null then raise notice 'authenticated maintenance sweep: public.customer_recovery_shares not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.customer_recovery_shares from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.customers') is null then raise notice 'authenticated maintenance sweep: public.customers not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.customers from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.data_keys') is null then raise notice 'authenticated maintenance sweep: public.data_keys not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.data_keys from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.encrypted_transactions') is null then raise notice 'authenticated maintenance sweep: public.encrypted_transactions not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.encrypted_transactions from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.invoices') is null then raise notice 'authenticated maintenance sweep: public.invoices not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.invoices from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.opk_key_rotations') is null then raise notice 'authenticated maintenance sweep: public.opk_key_rotations not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.opk_key_rotations from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.payments') is null then raise notice 'authenticated maintenance sweep: public.payments not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.payments from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.pending_widget_sessions') is null then raise notice 'authenticated maintenance sweep: public.pending_widget_sessions not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.pending_widget_sessions from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.platform_key_audit') is null then raise notice 'authenticated maintenance sweep: public.platform_key_audit not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.platform_key_audit from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_institutions_cache') is null then raise notice 'authenticated maintenance sweep: public.quiltt_institutions_cache not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.quiltt_institutions_cache from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_profile_map') is null then raise notice 'authenticated maintenance sweep: public.quiltt_profile_map not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.quiltt_profile_map from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_webhook_inbox') is null then raise notice 'authenticated maintenance sweep: public.quiltt_webhook_inbox not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.quiltt_webhook_inbox from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.source_wallets') is null then raise notice 'authenticated maintenance sweep: public.source_wallets not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.source_wallets from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.staff_users') is null then raise notice 'authenticated maintenance sweep: public.staff_users not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.staff_users from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_connections') is null then raise notice 'authenticated maintenance sweep: public.stealth_connections not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.stealth_connections from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_scan_ranges') is null then raise notice 'authenticated maintenance sweep: public.stealth_scan_ranges not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.stealth_scan_ranges from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_transactions') is null then raise notice 'authenticated maintenance sweep: public.stealth_transactions not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.stealth_transactions from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_utxos') is null then raise notice 'authenticated maintenance sweep: public.stealth_utxos not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.stealth_utxos from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.strike_webhook_events') is null then raise notice 'authenticated maintenance sweep: public.strike_webhook_events not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.strike_webhook_events from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.subaccounts') is null then raise notice 'authenticated maintenance sweep: public.subaccounts not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.subaccounts from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.subscriptions') is null then raise notice 'authenticated maintenance sweep: public.subscriptions not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.subscriptions from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.user_app_grants') is null then raise notice 'authenticated maintenance sweep: public.user_app_grants not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.user_app_grants from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.vault_security_events') is null then raise notice 'authenticated maintenance sweep: public.vault_security_events not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.vault_security_events from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.waitlist') is null then raise notice 'authenticated maintenance sweep: public.waitlist not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.waitlist from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.webhook_delivery') is null then raise notice 'authenticated maintenance sweep: public.webhook_delivery not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.webhook_delivery from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.workspace_admins') is null then raise notice 'authenticated maintenance sweep: public.workspace_admins not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.workspace_admins from authenticated'; end if;
end $$;

do $$ begin
  if to_regclass('public.wrapped_data_keys') is null then raise notice 'authenticated maintenance sweep: public.wrapped_data_keys not present, skipped';
  else execute 'revoke truncate, trigger, references, maintain on table public.wrapped_data_keys from authenticated'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2: stop the tap. Without this, table 35 arrives with the same four
-- privileges and this whole file has to be written again. FOR ROLE postgres is
-- load bearing: default privileges are per owning role and this does nothing
-- for tables created by any other role. Only the four maintenance privileges
-- are named, so INSERT, SELECT, UPDATE and DELETE keep flowing to new tables
-- exactly as they do now.
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke truncate, trigger, references, maintain on tables from authenticated;

-- ---------------------------------------------------------------------------
-- PART 3: assert the END STATE, not the change. Reads the catalogue back with
-- aclexplode rather than a fixed has_table_privilege list, so the failure names
-- the offending table and privilege.
--
-- This block runs at APPLY time and only at apply time. It catches a rebuilt
-- environment that never reached the target state, and a later migration that
-- undoes this one, because both are followed by an apply of this file. It does
-- NOT watch the cluster continuously: nothing here runs between two applies, so
-- a platform change made in that window is invisible to it. Continuous
-- comparison of one cluster against another is a separate mechanism.
-- ---------------------------------------------------------------------------

do $$
declare
  v_keep constant text[] := array['customers', 'connections', 'subaccounts', 'encrypted_transactions'];
  v_bad text;
  v_missing text;
begin
  -- B1. No table in schema public may leave the logged-in role holding any of
  -- the four maintenance privileges. Deliberately not narrowed to the list in
  -- part 1: if this fires for a table that is not in that list, a table exists
  -- that nobody measured. Add it to part 1 rather than narrowing this check.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relacl is not null
     and r.rolname = 'authenticated'
     and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
  if v_bad is not null then
    raise exception 'authenticated maintenance sweep FAILED: a table still grants the logged-in role a maintenance privilege, and TRUNCATE in particular is not filtered by row level security: %', v_bad;
  end if;

  -- B2. The default privilege must no longer hand the four out on new tables.
  -- Scoped to the owning role this file narrowed, because that is the only one
  -- it can narrow.
  select string_agg(a.privilege_type, ', ' order by a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and d.defaclobjtype = 'r'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and r.rolname = 'authenticated'
     and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');
  if v_bad is not null then
    raise exception 'authenticated maintenance sweep FAILED: the default privilege for role postgres still grants the logged-in role: %', v_bad;
  end if;

  -- B3. THE ASSERTION THAT PROTECTS WHAT WAS DELIBERATELY KEPT. The four data
  -- privileges must still be present on a named sample of tables the client
  -- writes on every session. Nothing in this file can remove them, which is
  -- exactly why the check is cheap; it is here so that a later sweep which does
  -- remove them fails on a rebuild instead of passing quietly. The sample is
  -- named rather than computed: a computed sample would shrink to nothing the
  -- moment the grants disappeared, which is the one case this must catch.
  select string_agg(format('%s:%s', s.t, s.p), ', ' order by s.t, s.p)
    into v_missing
    from (select t, p from unnest(v_keep) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p) s
   where to_regclass('public.' || s.t) is not null
     and not exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a
         join pg_roles r on r.oid = a.grantee
        where n.nspname = 'public'
          and c.relname = s.t
          and c.relacl is not null
          and r.rolname = 'authenticated'
          and a.privilege_type = s.p
     );
  if v_missing is not null then
    raise exception 'authenticated maintenance sweep FAILED: a data privilege the client depends on is missing, this file must never remove one: %', v_missing;
  end if;

  raise notice 'authenticated maintenance sweep: end state verified. No table in schema public grants the logged-in role TRUNCATE, TRIGGER, REFERENCES or MAINTAIN, the default privilege no longer grants them, and the four data privileges are still in place on the named sample.';
end $$;
