-- Revoke write grants from the anonymous role across schema public, keep the
-- two public forms working, and close the default privilege that keeps
-- recreating the problem.
--
-- WHAT IS WRONG TODAY
-- The project default privilege for tables created by postgres in schema
-- public grants the anonymous role INSERT, UPDATE and DELETE at creation
-- time. Forty-seven tables in public carry that grant as a result, measured
-- with aclexplode over pg_class.relacl for the anon role, privileges other
-- than SELECT. None of it comes from our migration tree: the only GRANT to
-- anon anywhere in supabase/ is a SELECT grant in another schema.
--
-- Nothing is reachable through those grants right now. Row level security is
-- enabled on all forty-seven, and no permissive write policy admits an
-- anonymous writer except on the two tables named below, where that is the
-- intent. So this is a missing wall behind a door that holds. It is worth
-- closing because the door is the only thing holding it.
--
-- WHAT THIS FILE DOES
--   Part 1  Removes INSERT, UPDATE and DELETE from anon on 45 tables, one
--           block per table.
--   Part 2  Removes UPDATE and DELETE only from waitlist and
--           adapter_requests, which must keep INSERT.
--   Part 3  Narrows the default privilege so table 48 does not arrive with
--           the same grant.
--   Part 4  Asserts the end state and fails loudly if it is not reached.
--
-- SELECT IS DELIBERATELY NOT REVOKED. This change is about write grants.
-- Reads are governed by row level security, and widening the scope to reads
-- here would turn a change that alters no behaviour into a risky one.
--
-- service_role IS DELIBERATELY NOT TOUCHED. It is the server side identity
-- and is never exposed to a browser.
--
-- THE TWO THAT KEEP INSERT, and why taking it would be customer visible:
--   public.waitlist          policy "Anyone can join waitlist"
--   public.adapter_requests  policy "Anyone can request an adapter"
-- Both policies are cmd=INSERT with roles anon and authenticated, and both
-- back a live public form. Revoking INSERT on either one turns a working
-- signup into a 42501 for every visitor. Neither policy uses UPDATE or
-- DELETE, so those go. Part 4 asserts the INSERT is still there afterwards,
-- because an assertion that proves the thing you deliberately kept is what
-- stops the next sweep removing it.
--
-- THE DEFAULT PRIVILEGE, and the decision taken on the second one.
-- ALTER DEFAULT PRIVILEGES is per owning role and silently does nothing for
-- tables created by any other role, so the FOR ROLE clause below is
-- load bearing rather than decoration. This file narrows the default owned
-- by postgres, which is the role our tables are created by and the one that
-- produced the forty-seven.
--
-- One project also carries a second default for public tables owned by
-- supabase_admin which still grants anon the wide set. It is NOT narrowed
-- here, and that is a decision rather than an oversight: our apply role is
-- postgres, which is not a superuser and cannot alter another role's default
-- privileges, so including it would make this migration fail rather than
-- make it stronger. The consequence is that a table created in public BY
-- supabase_admin on that project would still inherit the grant. That needs a
-- role we do not hold and is recorded separately.
--
-- WHY EVERY STATEMENT IS GUARDED ON THE TABLE EXISTING.
-- The table list was measured on one project. Twelve of the tables are not
-- present on the other, mostly reference data tables. A bare REVOKE on a
-- table that is not there fails with 42P01 and would take the whole deploy
-- down on the project that is missing it. Each block therefore checks
-- to_regclass first and raises a notice when it skips, so a skip is visible
-- in the deploy log instead of silent. The list is written out literally,
-- one block per table: it is a measurement, not a query, and it must never
-- become a loop over every table in public, which would strip the two public
-- forms and anything added since.
--
-- IDEMPOTENT. REVOKE and ALTER DEFAULT PRIVILEGES are absolute rather than
-- relative, so running this against a database already in the target state
-- changes nothing and the assertions then prove the state instead of failing.
-- The deploy will re-run this file at some point; that is a clean pass.
--
-- REVERSAL, spelled out rather than described. To put it back exactly as it
-- was, run for each of the 45 tables in part 1:
--     GRANT INSERT, UPDATE, DELETE ON TABLE public.<table> TO anon;
-- and for the two in part 2 (they already hold INSERT):
--     GRANT UPDATE, DELETE ON TABLE public.<table> TO anon;
-- and for part 3:
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT INSERT, UPDATE, DELETE ON TABLES TO anon;
-- Note two of the tables (customer_vault_meta, user_vault_meta) never held
-- DELETE, so the reversal above hands them a privilege they did not have.
-- If an exact restore matters, grant INSERT and UPDATE only on those two.
--
-- IF AN ASSERTION IN PART 4 FIRES, read the message before changing anything.
--   "still holds" naming a table in the list  -> this file did not do what it
--       claims, which is a real defect and not something to silence.
--   "outside the swept list" naming a table   -> a table exists with an anon
--       write grant that nobody swept. That is the same defect on a new
--       table. Add it to part 1 rather than narrowing the assertion.
--   "no longer holds INSERT" on waitlist or adapter_requests -> a public form
--       is about to break. Stop.

-- ---------------------------------------------------------------------------
-- PART 1: 45 tables lose INSERT, UPDATE and DELETE for anon.
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('public.agent_invitation_tokens') is null then raise notice 'anon sweep: public.agent_invitation_tokens not present, skipped';
  else execute 'revoke insert, update, delete on table public.agent_invitation_tokens from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.agent_members') is null then raise notice 'anon sweep: public.agent_members not present, skipped';
  else execute 'revoke insert, update, delete on table public.agent_members from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.audit_entries') is null then raise notice 'anon sweep: public.audit_entries not present, skipped';
  else execute 'revoke insert, update, delete on table public.audit_entries from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.audit_events') is null then raise notice 'anon sweep: public.audit_events not present, skipped';
  else execute 'revoke insert, update, delete on table public.audit_events from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.beta_approved_users') is null then raise notice 'anon sweep: public.beta_approved_users not present, skipped';
  else execute 'revoke insert, update, delete on table public.beta_approved_users from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.channel_state') is null then raise notice 'anon sweep: public.channel_state not present, skipped';
  else execute 'revoke insert, update, delete on table public.channel_state from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.commodity_prices') is null then raise notice 'anon sweep: public.commodity_prices not present, skipped';
  else execute 'revoke insert, update, delete on table public.commodity_prices from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.connections') is null then raise notice 'anon sweep: public.connections not present, skipped';
  else execute 'revoke insert, update, delete on table public.connections from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.customer_recovery_shares') is null then raise notice 'anon sweep: public.customer_recovery_shares not present, skipped';
  else execute 'revoke insert, update, delete on table public.customer_recovery_shares from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.customer_vault_meta') is null then raise notice 'anon sweep: public.customer_vault_meta not present, skipped';
  else execute 'revoke insert, update, delete on table public.customer_vault_meta from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.customers') is null then raise notice 'anon sweep: public.customers not present, skipped';
  else execute 'revoke insert, update, delete on table public.customers from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.encrypted_transactions') is null then raise notice 'anon sweep: public.encrypted_transactions not present, skipped';
  else execute 'revoke insert, update, delete on table public.encrypted_transactions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.exchange_rate_providers') is null then raise notice 'anon sweep: public.exchange_rate_providers not present, skipped';
  else execute 'revoke insert, update, delete on table public.exchange_rate_providers from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.exchange_rate_resolutions') is null then raise notice 'anon sweep: public.exchange_rate_resolutions not present, skipped';
  else execute 'revoke insert, update, delete on table public.exchange_rate_resolutions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.exchange_rates') is null then raise notice 'anon sweep: public.exchange_rates not present, skipped';
  else execute 'revoke insert, update, delete on table public.exchange_rates from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.historical_money_prices') is null then raise notice 'anon sweep: public.historical_money_prices not present, skipped';
  else execute 'revoke insert, update, delete on table public.historical_money_prices from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.historical_money_prices_resolutions') is null then raise notice 'anon sweep: public.historical_money_prices_resolutions not present, skipped';
  else execute 'revoke insert, update, delete on table public.historical_money_prices_resolutions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.inflation_rates') is null then raise notice 'anon sweep: public.inflation_rates not present, skipped';
  else execute 'revoke insert, update, delete on table public.inflation_rates from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.inflation_resolutions') is null then raise notice 'anon sweep: public.inflation_resolutions not present, skipped';
  else execute 'revoke insert, update, delete on table public.inflation_resolutions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.invoices') is null then raise notice 'anon sweep: public.invoices not present, skipped';
  else execute 'revoke insert, update, delete on table public.invoices from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.monetary_aggregates') is null then raise notice 'anon sweep: public.monetary_aggregates not present, skipped';
  else execute 'revoke insert, update, delete on table public.monetary_aggregates from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.opk_key_rotations') is null then raise notice 'anon sweep: public.opk_key_rotations not present, skipped';
  else execute 'revoke insert, update, delete on table public.opk_key_rotations from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.payments') is null then raise notice 'anon sweep: public.payments not present, skipped';
  else execute 'revoke insert, update, delete on table public.payments from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.pending_widget_sessions') is null then raise notice 'anon sweep: public.pending_widget_sessions not present, skipped';
  else execute 'revoke insert, update, delete on table public.pending_widget_sessions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.platform_key_audit') is null then raise notice 'anon sweep: public.platform_key_audit not present, skipped';
  else execute 'revoke insert, update, delete on table public.platform_key_audit from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.precious_metals_rates') is null then raise notice 'anon sweep: public.precious_metals_rates not present, skipped';
  else execute 'revoke insert, update, delete on table public.precious_metals_rates from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.precious_metals_resolutions') is null then raise notice 'anon sweep: public.precious_metals_resolutions not present, skipped';
  else execute 'revoke insert, update, delete on table public.precious_metals_resolutions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_institutions_cache') is null then raise notice 'anon sweep: public.quiltt_institutions_cache not present, skipped';
  else execute 'revoke insert, update, delete on table public.quiltt_institutions_cache from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_profile_map') is null then raise notice 'anon sweep: public.quiltt_profile_map not present, skipped';
  else execute 'revoke insert, update, delete on table public.quiltt_profile_map from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.quiltt_webhook_inbox') is null then raise notice 'anon sweep: public.quiltt_webhook_inbox not present, skipped';
  else execute 'revoke insert, update, delete on table public.quiltt_webhook_inbox from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.source_wallets') is null then raise notice 'anon sweep: public.source_wallets not present, skipped';
  else execute 'revoke insert, update, delete on table public.source_wallets from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.staff_users') is null then raise notice 'anon sweep: public.staff_users not present, skipped';
  else execute 'revoke insert, update, delete on table public.staff_users from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_connections') is null then raise notice 'anon sweep: public.stealth_connections not present, skipped';
  else execute 'revoke insert, update, delete on table public.stealth_connections from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_scan_ranges') is null then raise notice 'anon sweep: public.stealth_scan_ranges not present, skipped';
  else execute 'revoke insert, update, delete on table public.stealth_scan_ranges from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.stealth_transactions') is null then raise notice 'anon sweep: public.stealth_transactions not present, skipped';
  else execute 'revoke insert, update, delete on table public.stealth_transactions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.strike_webhook_events') is null then raise notice 'anon sweep: public.strike_webhook_events not present, skipped';
  else execute 'revoke insert, update, delete on table public.strike_webhook_events from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.subaccounts') is null then raise notice 'anon sweep: public.subaccounts not present, skipped';
  else execute 'revoke insert, update, delete on table public.subaccounts from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.subscriptions') is null then raise notice 'anon sweep: public.subscriptions not present, skipped';
  else execute 'revoke insert, update, delete on table public.subscriptions from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.tech_productivity_curves') is null then raise notice 'anon sweep: public.tech_productivity_curves not present, skipped';
  else execute 'revoke insert, update, delete on table public.tech_productivity_curves from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.user_app_grants') is null then raise notice 'anon sweep: public.user_app_grants not present, skipped';
  else execute 'revoke insert, update, delete on table public.user_app_grants from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.user_vault_meta') is null then raise notice 'anon sweep: public.user_vault_meta not present, skipped';
  else execute 'revoke insert, update, delete on table public.user_vault_meta from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.vault_security_events') is null then raise notice 'anon sweep: public.vault_security_events not present, skipped';
  else execute 'revoke insert, update, delete on table public.vault_security_events from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.wages') is null then raise notice 'anon sweep: public.wages not present, skipped';
  else execute 'revoke insert, update, delete on table public.wages from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.webhook_delivery') is null then raise notice 'anon sweep: public.webhook_delivery not present, skipped';
  else execute 'revoke insert, update, delete on table public.webhook_delivery from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.workspace_admins') is null then raise notice 'anon sweep: public.workspace_admins not present, skipped';
  else execute 'revoke insert, update, delete on table public.workspace_admins from anon'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2: the two live public forms. UPDATE and DELETE go, INSERT STAYS.
--
--   public.waitlist          keeps INSERT for policy "Anyone can join waitlist"
--   public.adapter_requests  keeps INSERT for policy "Anyone can request an adapter"
--
-- Both policies are cmd=INSERT with roles anon and authenticated. Removing
-- INSERT here breaks a visitor facing signup with a 42501. Part 4 asserts the
-- INSERT is still present after this file runs.
-- ---------------------------------------------------------------------------

do $$ begin
  if to_regclass('public.waitlist') is null then raise notice 'anon sweep: public.waitlist not present, skipped';
  else execute 'revoke update, delete on table public.waitlist from anon'; end if;
end $$;

do $$ begin
  if to_regclass('public.adapter_requests') is null then raise notice 'anon sweep: public.adapter_requests not present, skipped';
  else execute 'revoke update, delete on table public.adapter_requests from anon'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- PART 3: stop the tap. Without this, table 48 arrives with the same grant
-- and this whole file has to be written again. FOR ROLE postgres is load
-- bearing: default privileges are per owning role and this does nothing for
-- tables created by any other role.
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke insert, update, delete on tables from anon;

-- ---------------------------------------------------------------------------
-- PART 4: assert the END STATE, not the change. Reads the catalogue back with
-- aclexplode rather than a fixed has_table_privilege list, so a privilege
-- nobody thought of is caught too, and names the offending table and
-- privilege when it fails.
-- ---------------------------------------------------------------------------

do $$
declare
  v_swept constant text[] := array[
    'agent_invitation_tokens','agent_members','audit_entries','audit_events',
    'beta_approved_users','channel_state','commodity_prices','connections',
    'customer_recovery_shares','customer_vault_meta','customers',
    'encrypted_transactions','exchange_rate_providers','exchange_rate_resolutions',
    'exchange_rates','historical_money_prices','historical_money_prices_resolutions',
    'inflation_rates','inflation_resolutions','invoices','monetary_aggregates',
    'opk_key_rotations','payments','pending_widget_sessions','platform_key_audit',
    'precious_metals_rates','precious_metals_resolutions','quiltt_institutions_cache',
    'quiltt_profile_map','quiltt_webhook_inbox','source_wallets','staff_users',
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'strike_webhook_events','subaccounts','subscriptions','tech_productivity_curves',
    'user_app_grants','user_vault_meta','vault_security_events','wages',
    'webhook_delivery','workspace_admins'
  ];
  v_keep_insert constant text[] := array['waitlist','adapter_requests'];
  v_bad text;
  v_missing text;
begin
  -- A1. None of the swept tables may leave anon holding a non-SELECT
  -- privilege. This cannot fire unless the statements above did not do what
  -- they claim, which is exactly why it is here.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relacl is not null
     and r.rolname = 'anon'
     and a.privilege_type <> 'SELECT'
     and c.relname = any (v_swept);
  if v_bad is not null then
    raise exception 'anon write sweep FAILED: swept table still holds a write grant for anon: %', v_bad;
  end if;

  -- A2. No OTHER table in public may hold one either, apart from the two
  -- public forms keeping INSERT. If this fires, a table exists that nobody
  -- swept. Add it to part 1 rather than narrowing this check.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relacl is not null
     and r.rolname = 'anon'
     and a.privilege_type <> 'SELECT'
     and not (c.relname = any (v_swept))
     and not (c.relname = any (v_keep_insert) and a.privilege_type = 'INSERT');
  if v_bad is not null then
    raise exception 'anon write sweep FAILED: table outside the swept list holds a write grant for anon: %', v_bad;
  end if;

  -- A3. The two public forms must STILL hold INSERT. This is the assertion
  -- that protects what was deliberately kept.
  select string_agg(t, ', ')
    into v_missing
    from unnest(v_keep_insert) as t
   where to_regclass('public.' || t) is not null
     and not exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a
         join pg_roles r on r.oid = a.grantee
        where n.nspname = 'public'
          and c.relname = t
          and c.relacl is not null
          and r.rolname = 'anon'
          and a.privilege_type = 'INSERT'
     );
  if v_missing is not null then
    raise exception 'anon write sweep FAILED: public form no longer holds INSERT for anon, its signup is broken: %', v_missing;
  end if;

  -- A4. The default privilege must no longer hand out write on new tables.
  -- Scoped to the owning role this file narrowed, because that is the only
  -- one it can narrow.
  select string_agg(a.privilege_type, ', ' order by a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and d.defaclobjtype = 'r'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and r.rolname = 'anon'
     and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v_bad is not null then
    raise exception 'anon write sweep FAILED: default privileges for role postgres still grant anon: %', v_bad;
  end if;

  -- A5. Belt and braces on column level grants. A table level REVOKE takes
  -- the column grants with it, verified on a scratch table inside a rolled
  -- back block, so this should always pass. It costs nothing and it cannot
  -- break anything, and if it ever fires the assumption was wrong.
  select string_agg(format('%s.%s:%s', c.relname, att.attname, a.privilege_type), ', ')
    into v_bad
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(att.attacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and att.attacl is not null
     and r.rolname = 'anon'
     and a.privilege_type <> 'SELECT';
  if v_bad is not null then
    raise exception 'anon write sweep FAILED: anon holds a column level write grant: %', v_bad;
  end if;

  raise notice 'anon write sweep: end state verified. No write grant for anon in schema public except INSERT on the two public forms, and the postgres default privilege no longer grants one.';
end $$;
