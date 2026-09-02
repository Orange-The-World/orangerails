-- ADOPT the restricted agent read role or_agent_reader into the migration tree, and pin the
-- exact grant set it holds, so a project rebuilt from supabase/migrations carries the same role
-- with the same privileges instead of not carrying it at all.
--
-- THIS FILE DOES NOT CLAIM TO HAVE INTRODUCED THE ROLE. That wording is deliberate. The role
-- already existed on the development project before any statement in this repository ran:
-- pg_roles was read first and recorded rolsuper=false, rolbypassrls=true, rolcanlogin=false and
-- zero memberships. What created it is UNKNOWN. PostgreSQL does not record a role creation time,
-- a search of the repository clones for the literal string returned no matches (on clones that
-- were themselves stale, so that is a floor and not a proof), and an index search returned
-- nothing above the relevance floor. The honest statement is "searched, not found", not "does
-- not exist", and this file does not guess. What it does is end the problem going forward: after
-- this runs, the role and every privilege it holds are described by the repository rather than by
-- whatever ran out of band.
--
-- UNDO:
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM or_agent_reader;
--   REVOKE ALL ON ALL TABLES IN SCHEMA client_platform FROM or_agent_reader;
--   REVOKE ALL ON ALL TABLES IN SCHEMA supabase_migrations FROM or_agent_reader;
--   REVOKE USAGE ON SCHEMA public, client_platform, supabase_migrations FROM or_agent_reader;
--   -- and only if nothing connects as it:  DROP ROLE or_agent_reader;
--   A table level REVOKE ALL also clears that table's column level entries. That is not assumed
--   here: it was run against auth.users inside a rolled back transaction on the development
--   project and the 28 column entries went to 0.
--
-- MEASURED BEFORE WRITING THIS, on the development project, 2026-09-02 13:05 UTC (09:05 EDT),
-- not taken from a document:
--   role         rolsuper=false, rolbypassrls=true, rolcanlogin=false, rolreplication=false
--   schemas      USAGE on public, client_platform, supabase_migrations. No USAGE on auth, vault,
--                storage, extensions, cron, realtime, graphql, graphql_public, pgbouncer.
--   table wide   33 relations in public, 8 in client_platform, 1 in supabase_migrations
--   column wide  20 relations in public, 204 column grants in total
--   privileges   SELECT and nothing else, anywhere
--   secrets      zero columns matching the secret pattern below are readable
--
-- THE STATE MOVED WHILE IT WAS BEING MEASURED, which is the reason this file exists. Between
-- 12:56 and 13:05 UTC the same day, 6 relations went from table wide to column scoped and 15
-- columns beginning with encrypted_ were closed, all by hand and with no file behind any of it.
-- Every list below is from the 13:05 read, after that work finished.
--
-- WHY THE GRANTS ARE WRITTEN OUT AND NOT COMPUTED FROM A PATTERN. A loop of the shape "revoke the
-- table grant, then grant every column that does not look secret" widens the role on any table
-- where it holds only part of the columns today, because the rule is broader than the curated set
-- the role actually has. It would also hand the role relations it has never had at all. Every
-- grant below is a literal list read off the catalogue, so the end state of this file cannot
-- exceed what was measured. The pattern appears only in the assertion at the end, where being
-- broad is the point.
--
-- WHY THE COLUMN SCOPED TABLES ARE REVOKED FIRST AND THEN GRANTED. On a project that has drifted,
-- or that has been restored from a backup carrying an old table wide grant, granting columns
-- alone would leave the table wide grant in place and change nothing. The revoke makes the file
-- converge instead of quietly agreeing with the wrong state. It cannot widen anything: what is
-- granted back is a fixed literal list, not a computed one.
--
-- BYPASSRLS IS KEPT ON PURPOSE AND MUST NOT BE TIDIED AWAY. Every row level policy in public is
-- scoped TO authenticated and keyed on auth.uid(). A role that does not bypass row level security
-- and is not authenticated matches no policy, so it reads 0 rows from nearly every table and
-- answers zero to every question while reporting success. That failure is silent, which is worse
-- than a refusal. The wall around this role is therefore built out of GRANTS, not out of row
-- level security. If cross tenant reads are later judged unacceptable for an agent tool, that is
-- a different design (a per tenant login, or definer functions), not a one line ALTER ROLE.
--
-- LOGIN IS NOT SET HERE. On a project where the role is absent it is created NOLOGIN, which is
-- what the development project holds. On a project where it already exists, this file does not
-- touch the login attribute, so it cannot silently disable a role that some deployment has
-- deliberately enabled.
--
-- ORDERING. This file is numbered ABOVE 20260902213700, the vault meta grantee assertion, on
-- purpose. That assertion tolerates the role being absent, so on a rebuild it runs first, passes
-- on a project that has no such role yet, and this file then defines the role. Neither file
-- depends on the other's position.
--
-- A LIMIT THIS FILE CANNOT CLOSE, stated rather than hidden. The pg_net extension grants USAGE on
-- schema net and EXECUTE on its functions to PUBLIC, and net.http_request_queue is writable by
-- PUBLIC. or_agent_reader inherits all of that through PUBLIC, so it can queue an outbound HTTP
-- request. A grant made to PUBLIC cannot be revoked from one role, so nothing in a role scoped
-- migration can fix it, and revoking it from PUBLIC would change the platform for every role.
-- The assertion below deliberately does not check schema net, because it would fail on a state
-- this file has no power to correct. It is reported separately instead.
--
-- DEVELOPMENT ONLY. No production statement is run from this change. Promotion to production is a
-- separate two party write and is deliberately not in this file.
--
-- Re-running this file is a no-op that still verifies. It never grants twice and it never widens.

-- ---------------------------------------------------------------------------
-- 1. THE ROLE. Create it if absent, adopt it if present, and make sure the one
--    attribute that is load bearing is actually set.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader') THEN
    -- NOLOGIN: this role is reached by SET ROLE from a trusted connection, not by connecting as
    -- it. BYPASSRLS: see the header, it is the difference between a read tool that answers and
    -- one that silently answers zero.
    EXECUTE 'CREATE ROLE or_agent_reader NOLOGIN NOINHERIT BYPASSRLS';
    RAISE NOTICE 'created role or_agent_reader';
  ELSE
    RAISE NOTICE 'role or_agent_reader already exists; adopting it';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader' AND rolsuper) THEN
    RAISE EXCEPTION
      'or_agent_reader is a SUPERUSER on this cluster. This file will not narrow a superuser and refuses to pretend it has. Resolve that deliberately.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader' AND rolbypassrls) THEN
    EXECUTE 'ALTER ROLE or_agent_reader BYPASSRLS';
    RAISE NOTICE 'set BYPASSRLS on or_agent_reader';
  END IF;
END
$role$;

-- ---------------------------------------------------------------------------
-- 2. SCHEMAS. Three, and nothing else.
-- ---------------------------------------------------------------------------
-- Nothing is granted on auth, vault, storage, extensions, cron, realtime, graphql, graphql_public
-- or pgbouncer, and the assertion at the end proves the role cannot reach them. A schema level
-- wall is stronger than a column exclusion: a new table or column added to auth or vault is
-- refused by default rather than needing to be noticed and caught.
GRANT USAGE ON SCHEMA public              TO or_agent_reader;
GRANT USAGE ON SCHEMA client_platform     TO or_agent_reader;
GRANT USAGE ON SCHEMA supabase_migrations TO or_agent_reader;

-- ---------------------------------------------------------------------------
-- 3. NO DEFAULT PRIVILEGES. This is a hole, not a tidy up.
-- ---------------------------------------------------------------------------
-- The development project carried ALTER DEFAULT PRIVILEGES rows granting this role SELECT on
-- future tables in public and client_platform. That silently re-opens what was just closed: every
-- table created afterwards, including one carrying wrapped keys or a token hash, would become
-- readable table wide the moment it was created, with nobody deciding that. The role's grant set
-- is curated by this file and must not grow on its own.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT ON TABLES FROM or_agent_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA client_platform
  REVOKE SELECT ON TABLES FROM or_agent_reader;

-- ---------------------------------------------------------------------------
-- 4. TABLE WIDE SELECT: relations carrying no secret bearing column.
-- ---------------------------------------------------------------------------
-- A missing relation raises here rather than being skipped. That is intended: a silent skip
-- produces a role with fewer grants than the file describes and says nothing about it.
GRANT SELECT ON TABLE
  public.adapter_requests,
  public.agent_members,
  public.channel_state,
  public.consumed_refresh_nonces,
  public.data_keys,
  public.drain_alert_state,
  public.exchange_rate_resolutions,
  public.exchange_rates,
  public.opk_key_rotations,
  public.orbi_api_keys,
  public.orbi_usage_log,
  public.org_recovery_challenges,
  public.pending_widget_sessions,
  public.platform_key_audit,
  public.platform_rate_limits,
  public.platform_rate_limits_stale,
  public.queue_health_alert_state,
  public.quiltt_institutions_cache,
  public.quiltt_profile_map,
  public.quiltt_webhook_inbox,
  public.staff_users,
  public.stealth_connections,
  public.stealth_scan_ranges,
  public.stealth_transactions,
  public.stealth_utxos,
  public.strike_webhook_events,
  public.subaccounts,
  public.user_vault_keyring_watermark,
  public.vault_member_slots,
  public.vault_security_events,
  public.waitlist,
  public.webhook_delivery,
  public.workspace_admins
TO or_agent_reader;

-- public.orbi_api_keys is on that list and the name invites a second look. It holds hashes and
-- metadata, and the assertion at the end reads every column of every relation the role can reach,
-- so a plaintext key column appearing there later fails this file rather than passing quietly.

GRANT SELECT ON TABLE
  client_platform.api_keys,
  client_platform.api_plans,
  client_platform.api_usage,
  client_platform.applications,
  client_platform.audit_log,
  client_platform.organization_entitlements,
  client_platform.organization_members,
  client_platform.organizations
TO or_agent_reader;

-- The migration ledger. This is what lets an agent answer "what has been applied here" without
-- being handed a superuser connection, and it is the single most asked question in this repo.
GRANT SELECT ON TABLE supabase_migrations.schema_migrations TO or_agent_reader;

-- ---------------------------------------------------------------------------
-- 5. COLUMN SCOPED SELECT: relations that carry at least one secret bearing
--    column. The secret columns are simply never named.
-- ---------------------------------------------------------------------------
-- SELECT * FAILS on every table in this section, and the error reads "permission denied for
-- table <t>", which looks like a total wall and is not. PostgreSQL refuses a star select when the
-- role has no table level SELECT even if every column it would return is granted. Name your
-- columns. This is the single thing most likely to surprise whoever uses this role.
--
-- Each pair below is REVOKE ALL then GRANT SELECT (...). See the header for why.

REVOKE ALL ON TABLE public.agent_invitation_tokens FROM or_agent_reader;
GRANT SELECT (
  id, agent_member_id, owner_user_id, created_at, expires_at, redeemed_at, revoked_at,
  created_from_ip, created_from_ua
) ON TABLE public.agent_invitation_tokens TO or_agent_reader;

REVOKE ALL ON TABLE public.apps FROM or_agent_reader;
GRANT SELECT (
  id, slug, name, description, redirect_uri_pattern, created_at, updated_at
) ON TABLE public.apps TO or_agent_reader;

REVOKE ALL ON TABLE public.audit_entries FROM or_agent_reader;
GRANT SELECT (
  id, chain_height, actor_user_id, actor_member_id, action, resource_type, resource_id, reason,
  client_ip, client_user_agent, result, prev_hash, this_hash, created_at
) ON TABLE public.audit_entries TO or_agent_reader;

REVOKE ALL ON TABLE public.audit_events FROM or_agent_reader;
GRANT SELECT (
  id, actor_user_id, customer_id, event_type, payload, created_at
) ON TABLE public.audit_events TO or_agent_reader;

REVOKE ALL ON TABLE public.connections FROM or_agent_reader;
GRANT SELECT (
  id, provider_type, credentials_key_version, status, last_sync_at, last_sync_cursor, created_at,
  updated_at, subaccount_id, strike_subscription_id, quiltt_connection_id, account_emitted_id,
  account_fingerprint, data_key_generation
) ON TABLE public.connections TO or_agent_reader;

REVOKE ALL ON TABLE public.customer_recovery_shares FROM or_agent_reader;
GRANT SELECT (
  customer_id, share_index, shamir_threshold, shamir_total_shares, team_key_version, notes,
  created_at, updated_at
) ON TABLE public.customer_recovery_shares TO or_agent_reader;

-- The two vault meta tables below are the subject of a recorded ruling: the role keeps SELECT on
-- exactly these 22 (table, column) pairs and gets nothing else on them. They are public keys, KDF
-- parameters, version integers, timestamps and row ids. The reason the grant is kept at all is
-- that a live control question ("does any key version 2 vault exist") has to be answerable by the
-- read tool rather than by connecting as postgres. workspace_key_id is a pointer and the thing it
-- points at is closed: wrapped_data_keys.wrapped_ciphertext is not granted, below.
REVOKE ALL ON TABLE public.customer_vault_meta FROM or_agent_reader;
GRANT SELECT (
  customer_id, vault_key_version, kdf_algorithm, kdf_params, pqc_key_version, kem_public_key,
  sig_public_key, workspace_key_id, created_at, updated_at, vault_mode
) ON TABLE public.customer_vault_meta TO or_agent_reader;

REVOKE ALL ON TABLE public.user_vault_meta FROM or_agent_reader;
GRANT SELECT (
  user_id, vault_key_version, kdf_algorithm, kdf_params, created_at, updated_at, kem_public_key,
  sig_public_key, pqc_key_version, workspace_key_id, keyring_epoch
) ON TABLE public.user_vault_meta TO or_agent_reader;

REVOKE ALL ON TABLE public.customers FROM or_agent_reader;
GRANT SELECT (
  id, auth_user_id, name, email, customer_type, plan, status, created_at, updated_at, analytics_id
) ON TABLE public.customers TO or_agent_reader;

REVOKE ALL ON TABLE public.discovery_sessions FROM or_agent_reader;
GRANT SELECT (
  id, widget_session_id, external_wallet_id, provider_type, currency, created_at, expires_at
) ON TABLE public.discovery_sessions TO or_agent_reader;

REVOKE ALL ON TABLE public.encrypted_transactions FROM or_agent_reader;
GRANT SELECT (
  id, connection_id, external_id, payload_key_version, occurred_at, fetched_at, hmac_type,
  hmac_direction, hmac_counterparty, sealed_under, sealed_alg, data_key_generation
) ON TABLE public.encrypted_transactions TO or_agent_reader;

REVOKE ALL ON TABLE public.invoices FROM or_agent_reader;
GRANT SELECT (
  id, customer_id, subscription_id, amount_cents, currency, status, due_date, paid_at,
  stripe_invoice_id, hosted_invoice_url, created_at, updated_at
) ON TABLE public.invoices TO or_agent_reader;

REVOKE ALL ON TABLE public.org_vault_meta FROM or_agent_reader;
GRANT SELECT (
  vault_id, customer_id, org_recovery_kem_pubkey, org_recovery_sig_pubkey, vault_version,
  recovery_slot_version, recovery_code_seen_by, break_glass_notify_at, break_glass_available_at,
  rotation_required, created_at
) ON TABLE public.org_vault_meta TO or_agent_reader;

REVOKE ALL ON TABLE public.payments FROM or_agent_reader;
GRANT SELECT (
  id, invoice_id, customer_id, rail, amount_cents, currency, status, provider_payment_id,
  failure_reason, created_at, updated_at
) ON TABLE public.payments TO or_agent_reader;

REVOKE ALL ON TABLE public.platforms FROM or_agent_reader;
GRANT SELECT (
  id, slug, name, tier, is_internal, created_at, updated_at, display_name, display_brand_color,
  cors_origin, customer_id, webhook_url, quiltt_environment_id, quiltt_connector_id_link,
  quiltt_connector_id_reconnect, quiltt_catalog_profile_id, sink_format, widget_url,
  app_profile_slug, status, rotated_at, bootstrap_ttl_seconds, env
) ON TABLE public.platforms TO or_agent_reader;

REVOKE ALL ON TABLE public.source_wallets FROM or_agent_reader;
GRANT SELECT (
  id, connection_id, external_wallet_id, is_synced, encrypted_metadata_key_version, created_at,
  wallet_fingerprint, wallet_fingerprint_key_version, discovery_source
) ON TABLE public.source_wallets TO or_agent_reader;

REVOKE ALL ON TABLE public.subscriptions FROM or_agent_reader;
GRANT SELECT (
  id, customer_id, plan, status, stripe_subscription_id, current_period_start,
  current_period_end, cancel_at_period_end, created_at, updated_at
) ON TABLE public.subscriptions TO or_agent_reader;

REVOKE ALL ON TABLE public.user_app_grants FROM or_agent_reader;
GRANT SELECT (
  id, user_id, app_id, granted_scopes, granted_at, revoked_at, last_used_at, expires_at,
  rotated_at
) ON TABLE public.user_app_grants TO or_agent_reader;

REVOKE ALL ON TABLE public.user_vault_pubkeys FROM or_agent_reader;
GRANT SELECT (
  user_id, x25519_public_key, registered_at
) ON TABLE public.user_vault_pubkeys TO or_agent_reader;

REVOKE ALL ON TABLE public.wrapped_data_keys FROM or_agent_reader;
GRANT SELECT (
  id, data_key_id, recipient_user_id, algorithm, created_at, grant_sig, grant_sig_alg
) ON TABLE public.wrapped_data_keys TO or_agent_reader;

-- ---------------------------------------------------------------------------
-- 6. RESIDUE OUTSIDE THE THREE SCHEMAS.
-- ---------------------------------------------------------------------------
-- The development project carried 28 column level SELECT grants to this role on auth.users. They
-- are unreachable today because the role has no USAGE on schema auth, so this was not an
-- exposure, but it is one GRANT USAGE away from being one, and a rebuild from this tree would not
-- have them. The guard means this is a strict no-op on a project that never had them, which also
-- keeps the file from needing revoke rights it may not hold on a platform owned table.
DO $residue$
DECLARE
  reader_oid oid;
  n_before   int;
BEGIN
  SELECT oid INTO reader_oid FROM pg_roles WHERE rolname = 'or_agent_reader';

  SELECT count(*) INTO n_before
    FROM pg_attribute a, LATERAL aclexplode(a.attacl) ae
   WHERE a.attrelid = to_regclass('auth.users')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND ae.grantee = reader_oid;

  IF n_before > 0 THEN
    EXECUTE 'REVOKE ALL ON TABLE auth.users FROM or_agent_reader';
    RAISE NOTICE 'revoked % residual column grant(s) on auth.users', n_before;
  END IF;
END
$residue$;

-- ---------------------------------------------------------------------------
-- 7. PROVE IT. Every claim the header makes is checked here against the live
--    catalogue, and any one of them failing rolls the whole file back.
-- ---------------------------------------------------------------------------
-- has_column_privilege, never a read of attacl. attacl cannot see a table wide grant, so a table
-- the file missed would pass an attacl based check while being fully readable. That difference is
-- exactly what made an earlier hand audit of this role report a clean result on a table that was
-- not clean.
--
-- Views and materialised views are in scope on purpose. A view owned by another role and not
-- declared security_invoker re-exposes the columns underneath it, which is how a closed column
-- comes back through the side door. public.v_platform_quiltt_config is a live example: it selects
-- quiltt_api_key straight out of platforms, and the role holds nothing on it. If that ever
-- changes, this block fails.
DO $verify$
DECLARE
  -- Deliberately broader than the columns known to exist today. A check that can only fail on
  -- what it was already looking for is not a check. An earlier version of this pattern missed
  -- every encrypted_payload column in the database for exactly that reason.
  secret_pat CONSTANT text :=
    '(ciphertext|_wrapped$|token_hash|secret|privkey|verifier|api_key|_salt$|^account_key$|^org_vault_recovery_slot$|^encrypted_)';
  -- Version integers and generation counters are named after the thing they version, so they
  -- collide with the pattern above and carry nothing. This exclusion is why
  -- source_wallets.encrypted_metadata_key_version stays readable while encrypted_metadata does
  -- not.
  keep_pat   CONSTANT text := '(_version$)';

  allow_public   CONSTANT text[] := ARRAY[
    'adapter_requests','agent_members','channel_state','consumed_refresh_nonces','data_keys',
    'drain_alert_state','exchange_rate_resolutions','exchange_rates','opk_key_rotations',
    'orbi_api_keys','orbi_usage_log','org_recovery_challenges','pending_widget_sessions',
    'platform_key_audit','platform_rate_limits','platform_rate_limits_stale',
    'queue_health_alert_state','quiltt_institutions_cache','quiltt_profile_map',
    'quiltt_webhook_inbox','staff_users','stealth_connections','stealth_scan_ranges',
    'stealth_transactions','stealth_utxos','strike_webhook_events','subaccounts',
    'user_vault_keyring_watermark','vault_member_slots','vault_security_events','waitlist',
    'webhook_delivery','workspace_admins'];
  allow_client   CONSTANT text[] := ARRAY[
    'api_keys','api_plans','api_usage','applications','audit_log','organization_entitlements',
    'organization_members','organizations'];
  walled_schemas CONSTANT text[] := ARRAY[
    'auth','vault','storage','extensions','cron','realtime','graphql','graphql_public',
    'pgbouncer'];

  reader_oid oid;
  bad        text;
  n          int;
BEGIN
  SELECT oid INTO reader_oid FROM pg_roles WHERE rolname = 'or_agent_reader';
  IF reader_oid IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: role or_agent_reader does not exist after this migration ran';
  END IF;

  -- 7a. The attributes the header depends on.
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE oid = reader_oid AND rolbypassrls AND NOT rolsuper AND NOT rolreplication)
  THEN
    RAISE EXCEPTION
      'VERIFY FAILED: or_agent_reader must be BYPASSRLS, NOSUPERUSER and NOREPLICATION. Read the header before changing this.';
  END IF;

  -- 7b. No secret bearing column is readable, anywhere the role can reach.
  SELECT string_agg(n2.nspname || '.' || c.relname || '.' || a.attname, ', ' ORDER BY 1)
    INTO bad
    FROM pg_attribute a
    JOIN pg_class     c  ON c.oid = a.attrelid
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
   WHERE n2.nspname IN ('public', 'client_platform', 'supabase_migrations')
     AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~ secret_pat
     AND a.attname !~ keep_pat
     AND has_column_privilege(reader_oid, c.oid, a.attname, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader can read secret bearing column(s): %', bad;
  END IF;

  -- 7c. SELECT and nothing else. A read role that can write is not a read role.
  SELECT string_agg(DISTINCT n2.nspname || '.' || c.relname || ' ' || ae.privilege_type, ', ')
    INTO bad
    FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) ae
   WHERE ae.grantee = reader_oid AND ae.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader holds a non SELECT privilege: %', bad;
  END IF;

  SELECT string_agg(DISTINCT n2.nspname || '.' || c.relname || '.' || a.attname || ' ' || ae.privilege_type, ', ')
    INTO bad
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) ae
   WHERE ae.grantee = reader_oid AND ae.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader holds a non SELECT column privilege: %', bad;
  END IF;

  -- 7d. Nothing outside the three schemas. Checked through the ACL and by role oid, so a role
  -- whose name merely contains this one cannot satisfy it by accident.
  SELECT string_agg(DISTINCT n2.nspname || '.' || c.relname, ', ')
    INTO bad
    FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) ae
   WHERE ae.grantee = reader_oid
     AND n2.nspname NOT IN ('public', 'client_platform', 'supabase_migrations');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader holds a table grant outside its three schemas: %', bad;
  END IF;

  SELECT string_agg(DISTINCT n2.nspname || '.' || c.relname, ', ')
    INTO bad
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) ae
   WHERE ae.grantee = reader_oid
     AND n2.nspname NOT IN ('public', 'client_platform', 'supabase_migrations');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader holds a column grant outside its three schemas: %', bad;
  END IF;

  -- 7e. The walled schemas are actually walled. Schema net is deliberately not in this list: see
  -- the header, its reach comes from a PUBLIC grant that no role scoped file can revoke.
  SELECT string_agg(n2.nspname, ', ')
    INTO bad
    FROM pg_namespace n2
   WHERE n2.nspname = ANY (walled_schemas)
     AND has_schema_privilege(reader_oid, n2.oid, 'USAGE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: or_agent_reader has USAGE on walled schema(s): %', bad;
  END IF;

  -- 7f. No table wide read outside the list this file names. This is what catches a restored
  -- backup or a default privilege row re-granting the role something nobody decided on.
  SELECT string_agg(n2.nspname || '.' || c.relname, ', ')
    INTO bad
    FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND n2.nspname IN ('public', 'client_platform', 'supabase_migrations')
     AND has_table_privilege(reader_oid, c.oid, 'SELECT')
     AND NOT (
          (n2.nspname = 'public'              AND c.relname = ANY (allow_public))
       OR (n2.nspname = 'client_platform'     AND c.relname = ANY (allow_client))
       OR (n2.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations')
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'VERIFY FAILED: or_agent_reader can read relation(s) table wide that this file does not name: %', bad;
  END IF;

  -- 7g. No default privileges. If this row comes back, every future table is granted silently.
  SELECT count(*) INTO n
    FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) ae
   WHERE ae.grantee = reader_oid;
  IF n > 0 THEN
    RAISE EXCEPTION
      'VERIFY FAILED: % default privilege row(s) still grant or_agent_reader on objects not yet created', n;
  END IF;

  -- 7h. A positive control, so the block cannot pass by the role holding nothing at all. Every
  -- assertion above is satisfied by a role with no privileges whatsoever, and a migration that
  -- passes by having done nothing is the failure mode this whole file exists to end.
  SELECT count(*) INTO n
    FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
   WHERE n2.nspname = 'public'
     AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND has_table_privilege(reader_oid, c.oid, 'SELECT');
  IF n <> 33 THEN
    RAISE EXCEPTION
      'VERIFY FAILED: expected 33 table wide readable relations in public, found %', n;
  END IF;

  IF NOT has_column_privilege(reader_oid, 'public.user_vault_meta'::regclass, 'vault_key_version', 'SELECT')
     OR NOT has_column_privilege(reader_oid, 'public.platforms'::regclass, 'slug', 'SELECT')
     OR NOT has_table_privilege(reader_oid, 'supabase_migrations.schema_migrations'::regclass, 'SELECT')
  THEN
    RAISE EXCEPTION
      'VERIFY FAILED: the role cannot read something it is supposed to read. The grants above did not take.';
  END IF;

  RAISE NOTICE 'or_agent_reader verified: 33 public + 8 client_platform + 1 migrations table wide, 20 column scoped, no secret column readable, SELECT only, three schemas only';
END
$verify$;
