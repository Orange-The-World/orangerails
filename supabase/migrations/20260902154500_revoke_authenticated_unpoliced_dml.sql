-- 20260902154500_revoke_authenticated_unpoliced_dml.sql
--
-- OR-T1421, out of the enumeration on OR-T1409.
--
-- WHAT THIS DOES
-- Removes, from the logged-in role, every table privilege in schema public
-- that no RLS policy admits, on the 30 tables named below. 83 table and
-- command combinations in total.
--
-- WHY IT IS SAFE
-- Each of these combinations is unreachable today. The table has row level
-- security enabled and there is no policy for that command that names the
-- logged-in role or PUBLIC, so PostgreSQL denies the statement whatever the
-- privilege says. Every write that actually happens to these tables comes
-- from an edge function holding the service role key, and the service role
-- bypasses RLS entirely. Nothing that works today depends on any privilege
-- removed here.
--
-- WHY IT IS WORTH DOING ANYWAY
-- Six of these tables have RLS enabled and no policies at all:
-- opk_key_rotations, pending_widget_sessions, platform_key_audit,
-- quiltt_profile_map, quiltt_webhook_inbox, strike_webhook_events. They are
-- closed today only because no policy exists. The day someone adds a single
-- policy for a single command to one of them, every other privilege
-- underneath becomes live, and the reviewer of that PR will be reading the
-- new policy, not a privilege set from months earlier. Revoking now means
-- the privilege set matches the client surface that actually exists.
--
-- MEASURED, NOT ASSUMED
-- Enumerated live against the dev project on 2026-09-02 by the DBA, not
-- copied from the earlier ticket. The query is the one in the assertion
-- block at the foot of this file, run without the table filter. It returned
-- 87 combinations for the logged-in role across 31 tables. 83 of those, on
-- the 30 tables listed here, are the set adjudicated on OR-T1409 and are
-- what this migration removes. The other 4 are on webhook_delivery, which
-- the earlier enumeration did not report; they are NOT in this migration
-- because they have not been adjudicated against the client surface, and
-- including an unadjudicated table in an adjudicated sweep is how a sweep
-- stops being trustworthy. They are ticketed separately.
--
-- THE COLUMN LEVEL TRAP, CHECKED RATHER THAN ASSUMED
-- A table level REVOKE also clears COLUMN level privileges for that role on
-- that table. That is the defect caught earlier on user_vault_meta. Before
-- writing this file every column level privilege in schema public naming the
-- anonymous or the logged-in role was enumerated. They exist on exactly three
-- tables: apps, platforms and user_vault_meta. NONE of those three is in this
-- migration, so no column level privilege can be destroyed by it. Assertion
-- A3 below re-checks that after the fact. Be clear about what A3 can and
-- cannot prove: it confirms none exists afterwards, which is a drift guard
-- for a future re-run. The proof that none was destroyed is the measurement
-- above, taken before the change.
--
-- REVERSIBLE
-- Every statement here has an exact inverse. To undo the whole migration,
-- run the GRANT statements in the ROLLBACK block at the foot of this file.
-- Restoring these privileges restores an unreachable privilege set, so the
-- rollback is safe but also has no behavioural effect on its own.
--
-- IDEMPOTENT
-- REVOKE on a privilege that is not held is a no-op in PostgreSQL and does
-- not error, so this file can be re-run any number of times. The assertion
-- block is read only.
--
-- NOT IN SCOPE, ON PURPOSE
-- The anonymous role's unpoliced SELECT privileges (23 tables, measured the
-- same wake) are NOT touched here. Revoking a SELECT privilege changes what
-- the caller observes: today an anonymous read of these tables returns an
-- empty result, afterwards it returns a permission error. That is visible to
-- client code and has not been adjudicated against the client surface the way
-- the 83 here have. Separate ticket, separate PR.

begin;

-- ---------------------------------------------------------------------------
-- The 83 revocations, one statement per table, privileges named explicitly so
-- the diff is readable. Nothing here uses ALL: ALL would also remove the
-- privileges that policies DO admit on these same tables.
-- ---------------------------------------------------------------------------

revoke delete, select, update on table public.adapter_requests from authenticated;
revoke delete, insert, update on table public.agent_invitation_tokens from authenticated;
revoke delete, insert on table public.agent_members from authenticated;
revoke delete, insert, update on table public.audit_entries from authenticated;
revoke delete, insert, update on table public.audit_events from authenticated;
revoke delete on table public.channel_state from authenticated;
revoke delete on table public.customer_recovery_shares from authenticated;
revoke delete, insert on table public.customers from authenticated;
revoke delete, insert, update on table public.data_keys from authenticated;
revoke delete, insert, update on table public.invoices from authenticated;
revoke delete, insert, select, update on table public.opk_key_rotations from authenticated;
revoke delete, insert, update on table public.payments from authenticated;
revoke delete, insert, select, update on table public.pending_widget_sessions from authenticated;
revoke delete, insert, select, update on table public.platform_key_audit from authenticated;
revoke delete, insert, update on table public.quiltt_institutions_cache from authenticated;
revoke delete, insert, select, update on table public.quiltt_profile_map from authenticated;
revoke delete, insert, select, update on table public.quiltt_webhook_inbox from authenticated;
revoke delete, insert, update on table public.staff_users from authenticated;
revoke delete, insert, update on table public.stealth_connections from authenticated;
revoke delete, insert, update on table public.stealth_scan_ranges from authenticated;
revoke delete, insert, update on table public.stealth_transactions from authenticated;
revoke delete, insert, update on table public.stealth_utxos from authenticated;
revoke delete, insert, select, update on table public.strike_webhook_events from authenticated;
revoke delete, insert, update on table public.subaccounts from authenticated;
revoke delete, insert, update on table public.subscriptions from authenticated;
revoke delete on table public.user_app_grants from authenticated;
revoke delete, update on table public.vault_security_events from authenticated;
revoke delete, select, update on table public.waitlist from authenticated;
revoke update on table public.workspace_admins from authenticated;
revoke update on table public.wrapped_data_keys from authenticated;

-- ---------------------------------------------------------------------------
-- Assertions. These run on every apply, on both clusters. A migration that
-- cannot say what it achieved has not said anything, and a REVOKE that
-- silently did nothing looks exactly like one that worked.
--
-- A1 proves the intended privileges are gone.
-- A2 proves the privileges that policies DO admit are still there, which is
--    what catches an over-broad revoke. This is the assertion that would have
--    caught using ALL instead of naming the commands.
-- A3 proves no column level privilege for the anonymous or logged-in role
--    exists on these 30 tables, which is the column level trap named in the
--    header.
-- ---------------------------------------------------------------------------
do $$
declare
  tbls text[] := array[
    'adapter_requests','agent_invitation_tokens','agent_members','audit_entries',
    'audit_events','channel_state','customer_recovery_shares','customers',
    'data_keys','invoices','opk_key_rotations','payments',
    'pending_widget_sessions','platform_key_audit','quiltt_institutions_cache',
    'quiltt_profile_map','quiltt_webhook_inbox','staff_users',
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'stealth_utxos','strike_webhook_events','subaccounts','subscriptions',
    'user_app_grants','vault_security_events','waitlist','workspace_admins',
    'wrapped_data_keys'
  ];
  n_tables      int;
  n_leftover    int;
  n_lost        int;
  n_col         int;
  leftover_list text;
  lost_list     text;
begin
  -- Count first. A sweep that cannot say "30 of 30" cannot say anything, and
  -- a table renamed or dropped upstream would otherwise make this whole block
  -- pass by examining nothing.
  select count(*) into n_tables
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r','p')
     and c.relname = any(tbls);

  if n_tables <> array_length(tbls, 1) then
    raise exception
      'OR-T1421 assertion A0 failed: expected % tables in schema public, found %. A table in the list was renamed or dropped, so the assertions below would examine an incomplete set.',
      array_length(tbls, 1), n_tables;
  end if;

  -- A1: no DML privilege for the logged-in role survives on these tables
  -- where no policy admits that command.
  select count(*), coalesce(string_agg(t || ':' || p, ', ' order by t, p), '')
    into n_leftover, leftover_list
    from (
      select c.relname as t, x.pt as p
        from pg_class c
        cross join lateral aclexplode(c.relacl) as x(gr, ge, pt, ig)
        join pg_roles r on r.oid = x.ge
       where c.relnamespace = 'public'::regnamespace
         and c.relkind in ('r','p')
         and c.relname = any(tbls)
         and r.rolname = 'authenticated'
         and x.pt in ('SELECT','INSERT','UPDATE','DELETE')
         and not exists (
           select 1
             from pg_policies pol
            where pol.schemaname = 'public'
              and pol.tablename = c.relname
              and (pol.cmd = x.pt or pol.cmd = 'ALL')
              and (pol.roles @> array['authenticated']::name[]
                   or pol.roles @> array['public']::name[])
         )
    ) s;

  if n_leftover <> 0 then
    raise exception
      'OR-T1421 assertion A1 failed: % unpoliced privilege(s) still held by the logged-in role after the revoke: %',
      n_leftover, leftover_list;
  end if;

  -- A2: every privilege a policy DOES admit is still held. This is the
  -- retention half. Without it, an over-broad revoke passes A1 perfectly.
  select count(*), coalesce(string_agg(t || ':' || p, ', ' order by t, p), '')
    into n_lost, lost_list
    from (
      select distinct pol.tablename as t, pol.cmd as p
        from pg_policies pol
        join pg_class c
          on c.relname = pol.tablename
         and c.relnamespace = 'public'::regnamespace
       where pol.schemaname = 'public'
         and pol.tablename = any(tbls)
         and pol.cmd in ('SELECT','INSERT','UPDATE','DELETE')
         and (pol.roles @> array['authenticated']::name[]
              or pol.roles @> array['public']::name[])
         and not has_table_privilege('authenticated', c.oid, pol.cmd)
    ) s;

  if n_lost <> 0 then
    raise exception
      'OR-T1421 assertion A2 failed: % policy-backed privilege(s) were removed and must be restored: %',
      n_lost, lost_list;
  end if;

  -- A3: the column level trap. Zero before this migration, must be zero
  -- after. See the header for what this can and cannot prove.
  select count(*) into n_col
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    cross join lateral aclexplode(a.attacl) as x(gr, ge, pt, ig)
    join pg_roles r on r.oid = x.ge
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r','p')
     and c.relname = any(tbls)
     and not a.attisdropped
     and a.attnum > 0
     and a.attacl is not null
     and r.rolname in ('anon','authenticated');

  if n_col <> 0 then
    raise exception
      'OR-T1421 assertion A3 failed: % column level privilege(s) for the anonymous or logged-in role exist on the swept tables. None existed before this migration, so either this migration destroyed a set that was added since it was written, or a later change introduced one. Read pg_attribute.attacl before re-running.',
      n_col;
  end if;

  raise notice
    'OR-T1421: % of % tables examined, 0 unpoliced privileges left for the logged-in role, 0 policy-backed privileges lost, 0 column level privileges affected.',
    n_tables, array_length(tbls, 1);
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK. Exact inverse of every statement above. Restores an unreachable
-- privilege set, so running it undoes the migration without changing what any
-- caller can actually do.
--
-- begin;
-- grant delete, select, update on table public.adapter_requests to authenticated;
-- grant delete, insert, update on table public.agent_invitation_tokens to authenticated;
-- grant delete, insert on table public.agent_members to authenticated;
-- grant delete, insert, update on table public.audit_entries to authenticated;
-- grant delete, insert, update on table public.audit_events to authenticated;
-- grant delete on table public.channel_state to authenticated;
-- grant delete on table public.customer_recovery_shares to authenticated;
-- grant delete, insert on table public.customers to authenticated;
-- grant delete, insert, update on table public.data_keys to authenticated;
-- grant delete, insert, update on table public.invoices to authenticated;
-- grant delete, insert, select, update on table public.opk_key_rotations to authenticated;
-- grant delete, insert, update on table public.payments to authenticated;
-- grant delete, insert, select, update on table public.pending_widget_sessions to authenticated;
-- grant delete, insert, select, update on table public.platform_key_audit to authenticated;
-- grant delete, insert, update on table public.quiltt_institutions_cache to authenticated;
-- grant delete, insert, select, update on table public.quiltt_profile_map to authenticated;
-- grant delete, insert, select, update on table public.quiltt_webhook_inbox to authenticated;
-- grant delete, insert, update on table public.staff_users to authenticated;
-- grant delete, insert, update on table public.stealth_connections to authenticated;
-- grant delete, insert, update on table public.stealth_scan_ranges to authenticated;
-- grant delete, insert, update on table public.stealth_transactions to authenticated;
-- grant delete, insert, update on table public.stealth_utxos to authenticated;
-- grant delete, insert, select, update on table public.strike_webhook_events to authenticated;
-- grant delete, insert, update on table public.subaccounts to authenticated;
-- grant delete, insert, update on table public.subscriptions to authenticated;
-- grant delete on table public.user_app_grants to authenticated;
-- grant delete, update on table public.vault_security_events to authenticated;
-- grant delete, select, update on table public.waitlist to authenticated;
-- grant update on table public.workspace_admins to authenticated;
-- grant update on table public.wrapped_data_keys to authenticated;
-- commit;
-- ---------------------------------------------------------------------------
