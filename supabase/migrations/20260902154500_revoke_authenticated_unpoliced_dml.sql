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
-- MEASURED ON BOTH CLUSTERS, NOT ASSUMED. All figures read live 2026-09-02.
--   dev   30 of 30 tables present, 83 unpoliced combinations, 0 policy
--         backed privileges currently missing, 0 column level privileges
--         for the anonymous or logged-in role on these tables.
--   prod  29 of 30 tables present (stealth_utxos does not exist there yet),
--         79 unpoliced combinations, 0 policy backed privileges currently
--         missing, 0 column level privileges. Every one of the 83 pairs was
--         checked against the production policy set: NONE of them is
--         admitted by a production policy, so this removes nothing that
--         works on production either.
-- The enumeration is the same query as assertion A1 below, run without the
-- table filter. It was re-run from scratch rather than copied from the
-- earlier ticket.
--
-- WHY A LOOP AND NOT 30 PLAIN REVOKE STATEMENTS
-- Because the two clusters are not at the same schema version and this file
-- runs on both. stealth_utxos exists on dev and does not exist on prod. A
-- plain REVOKE naming a missing relation raises 42P01 and aborts the entire
-- migration, so a flat statement list would have failed the production
-- apply. Ordering would probably have saved it, since the migration that
-- creates the table applies first, but "probably, because of ordering" is
-- not a property worth betting a production apply on. The loop skips a
-- relation that is not present, says so loudly in the apply log, and
-- asserts that present plus absent equals the whole list, so a typo in a
-- table name cannot be silently skipped.
--
-- ONE TABLE DELIBERATELY EXCLUDED
-- The same enumeration also returns 4 combinations on webhook_delivery, and
-- they are NOT in this migration. They were not part of the adjudication
-- against the client surface that cleared the other 83, and putting an
-- unadjudicated table into an adjudicated sweep is how a sweep stops being
-- worth trusting. Ticketed separately.
--
-- THE COLUMN LEVEL TRAP, CHECKED RATHER THAN ASSUMED
-- A table level REVOKE also clears COLUMN level privileges for that role on
-- that table. That is the defect caught earlier on user_vault_meta. Before
-- writing this file every column level privilege in schema public naming the
-- anonymous or the logged-in role was enumerated on both clusters. They
-- exist on exactly three tables: apps, platforms and user_vault_meta. NONE
-- of those three is in this migration, so no column level privilege can be
-- destroyed by it. Assertion A3 re-checks it after the fact. Be clear about
-- what A3 can and cannot prove: it confirms none exists afterwards, which is
-- a drift guard for a future re-run. The proof that none was destroyed is
-- the measurement above, taken before the change.
--
-- REVERSIBLE
-- Every revocation here has an exact inverse. To undo the whole migration,
-- run the GRANT statements in the ROLLBACK block at the foot of this file.
-- Restoring these privileges restores an unreachable privilege set, so the
-- rollback is safe and has no behavioural effect on its own.
--
-- IDEMPOTENT
-- REVOKE on a privilege that is not held is a no-op in PostgreSQL and does
-- not error, so this file can be re-run any number of times on either
-- cluster. The assertions are read only.
--
-- NOT IN SCOPE, ON PURPOSE
-- The anonymous role's unpoliced SELECT privileges (23 tables on dev,
-- measured the same wake) are NOT touched here. Revoking a SELECT privilege
-- changes what the caller observes: today an anonymous read of these tables
-- returns an empty result, afterwards it returns a permission error. That is
-- visible to client code and has not been adjudicated against the client
-- surface the way these 83 have. Separate ticket, separate PR.

begin;

do $$
declare
  -- One row per table: the table name, then the privileges to remove from
  -- the logged-in role. Nothing here uses ALL: ALL would also remove the
  -- privileges that policies DO admit on these same tables.
  sweep text[][] := array[
    ['adapter_requests',          'delete, select, update'],
    ['agent_invitation_tokens',   'delete, insert, update'],
    ['agent_members',             'delete, insert'],
    ['audit_entries',             'delete, insert, update'],
    ['audit_events',              'delete, insert, update'],
    ['channel_state',             'delete'],
    ['customer_recovery_shares',  'delete'],
    ['customers',                 'delete, insert'],
    ['data_keys',                 'delete, insert, update'],
    ['invoices',                  'delete, insert, update'],
    ['opk_key_rotations',         'delete, insert, select, update'],
    ['payments',                  'delete, insert, update'],
    ['pending_widget_sessions',   'delete, insert, select, update'],
    ['platform_key_audit',        'delete, insert, select, update'],
    ['quiltt_institutions_cache', 'delete, insert, update'],
    ['quiltt_profile_map',        'delete, insert, select, update'],
    ['quiltt_webhook_inbox',      'delete, insert, select, update'],
    ['staff_users',               'delete, insert, update'],
    ['stealth_connections',       'delete, insert, update'],
    ['stealth_scan_ranges',       'delete, insert, update'],
    ['stealth_transactions',      'delete, insert, update'],
    ['stealth_utxos',             'delete, insert, update'],
    ['strike_webhook_events',     'delete, insert, select, update'],
    ['subaccounts',               'delete, insert, update'],
    ['subscriptions',             'delete, insert, update'],
    ['user_app_grants',           'delete'],
    ['vault_security_events',     'delete, update'],
    ['waitlist',                  'delete, select, update'],
    ['workspace_admins',          'update'],
    ['wrapped_data_keys',         'update']
  ];
  i          int;
  tname      text;
  privs      text;
  n_total    int := array_length(sweep, 1);
  n_present  int := 0;
  n_absent   int := 0;
  absent_list text := '';
begin
  for i in 1 .. n_total loop
    tname := sweep[i][1];
    privs := sweep[i][2];

    if to_regclass('public.' || quote_ident(tname)) is null then
      n_absent := n_absent + 1;
      absent_list := absent_list || case when absent_list = '' then '' else ', ' end || tname;
      continue;
    end if;

    execute format('revoke %s on table public.%I from authenticated', privs, tname);
    n_present := n_present + 1;
  end loop;

  -- A0. A sweep that cannot say "N of N" cannot say anything. Every entry
  -- must be accounted for as either swept or genuinely absent, so a
  -- misspelled table name shows up as an absence rather than vanishing.
  if n_present + n_absent <> n_total then
    raise exception
      'OR-T1421 assertion A0 failed: % entries in the sweep list, % swept, % absent. These must add up.',
      n_total, n_present, n_absent;
  end if;

  if n_present = 0 then
    raise exception
      'OR-T1421 assertion A0 failed: not one of the % tables was present on this target. That is not a clean sweep, it is a sweep that swept nothing.',
      n_total;
  end if;

  if n_absent > 0 then
    raise notice
      'OR-T1421: % of % tables not present on this target and therefore skipped: %. This is expected on a cluster that has not yet applied the migration that creates them.',
      n_absent, n_total, absent_list;
  end if;

  raise notice 'OR-T1421: swept % of % tables.', n_present, n_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assertions. These run on every apply, on both clusters, and only over the
-- tables that are actually present on this target.
--
-- A1 proves the intended privileges are gone.
-- A2 proves the privileges that policies DO admit are still there, which is
--    what catches an over-broad revoke. This is the assertion that would
--    have caught using ALL instead of naming the commands.
-- A3 proves no column level privilege for the anonymous or logged-in role
--    exists on these tables, which is the column level trap named above.
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
  n_examined    int;
  n_leftover    int;
  n_lost        int;
  n_col         int;
  leftover_list text;
  lost_list     text;
begin
  select count(*) into n_examined
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r','p')
     and c.relname = any(tbls);

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
      'OR-T1421 assertion A1 failed: % unpoliced privilege(s) still held by the logged-in role after the sweep: %',
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

  -- A3: the column level trap. Zero before this migration on both clusters,
  -- must be zero after. See the header for what this can and cannot prove.
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
      'OR-T1421 assertion A3 failed: % column level privilege(s) for the anonymous or logged-in role exist on the swept tables. None existed on either cluster before this migration, so either this migration destroyed a set added since it was written, or a later change introduced one. Read pg_attribute.attacl before re-running.',
      n_col;
  end if;

  raise notice
    'OR-T1421: % of % listed tables present and examined, 0 unpoliced privileges left for the logged-in role, 0 policy-backed privileges lost, 0 column level privileges affected.',
    n_examined, array_length(tbls, 1);
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK. Exact inverse of every revocation above. Restores an unreachable
-- privilege set, so running it undoes the migration without changing what any
-- caller can actually do. Run only the lines for tables that exist on the
-- target you are rolling back.
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
