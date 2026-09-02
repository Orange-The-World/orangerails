-- Revoke anon's implicit privileges on sequences in schema public, both the live grants
-- and the default ACL that would silently re-grant them to any future sequence.
--
-- Out of OR-T1392 (Sr Dev A) and OR-T1394 (the CTO). The type-S default privilege on role
-- postgres in schema public currently reads anon=rwU, so every sequence any future
-- migration creates in public inherits SELECT, UPDATE and USAGE for anon whether or not
-- the migration author intended it. Two sequences already carry that grant on their own
-- relacl today: audit_entries_chain_height_seq (feeds audit_entries.chain_height) and
-- orbi_usage_log_id_seq (feeds orbi_usage_log.id). Neither table anon can INSERT into
-- (waitlist, adapter_requests) uses an identity column or a nextval default, both use
-- gen_random_uuid() primary keys, so anon needs zero sequence privileges anywhere in
-- this schema.
--
-- THIS FILE IS EXPECTED TO BE A NO-OP ON BOTH PROJECTS by the time it applies. The prod
-- grant is live right now and is being revoked out of band through the approval queue,
-- which runs before this migration reaches prod. Do not read the no-op as a broken
-- migration; the assertion block below is the part that must never be a no-op, because
-- it is what stops a rebuilt or reseeded environment from silently reinheriting the
-- grant this file removes.
--
-- Do NOT touch the supabase_admin default-ACL row. OR-T1388 established that no role we
-- hold can change it (fails 42501, reproduced on the admin surface), and prod does not
-- carry that row at all. Assertions (a) and (b) below exist to catch that row becoming
-- reachable again, not to fix it.
--
-- The objtype 'f' default (anon=X, EXECUTE) is CORRECT and out of scope for this file.
-- That is how PostgREST reaches an anon-callable RPC at all. Do not assert it away and
-- do not revoke it.
--
-- Idempotent: ALTER DEFAULT PRIVILEGES ... REVOKE and REVOKE ALL are both no-ops when
-- the role already holds nothing.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

DO $$
DECLARE
  v_count int;
  v_privs text[];
BEGIN
  -- a) zero public relations owned by supabase_admin. If this is nonzero, the still-open
  -- supabase_admin default ACL becomes reachable through whatever the relation is, and
  -- the checks below no longer mean what they say.
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relowner = 'supabase_admin'::regrole;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon-sequence-sweep: % relation(s) in schema public are owned by supabase_admin; the still-open default ACL on that role would hand anon a live grant on anything it owns', v_count;
  END IF;

  -- b) zero public functions owned by supabase_admin, same hazard as (a).
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proowner = 'supabase_admin'::regrole;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon-sequence-sweep: % function(s) in schema public are owned by supabase_admin; same reachable default-ACL hazard as the relation check', v_count;
  END IF;

  -- c) the postgres-owned default for TABLES (objtype 'r') must read anon=r, SELECT only.
  SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) INTO v_privs
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
  JOIN pg_roles gr ON gr.oid = a.grantee
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
    AND d.defaclobjtype = 'r' AND gr.rolname = 'anon';
  IF v_privs IS DISTINCT FROM ARRAY['SELECT'] THEN
    RAISE EXCEPTION 'anon-sequence-sweep: postgres default privilege for TABLES in schema public grants anon % instead of exactly {SELECT}; this file does not change the table-side default, so a drift here means it moved since OR-T1388/OR-T1394', COALESCE(v_privs::text, 'no grant at all');
  END IF;

  -- d) the postgres-owned default for SEQUENCES (objtype 'S') must not mention anon at
  -- all. This is the assertion the REVOKE statements above exist to satisfy.
  SELECT array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) INTO v_privs
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
  JOIN pg_roles gr ON gr.oid = a.grantee
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
    AND d.defaclobjtype = 'S' AND gr.rolname = 'anon';
  IF v_privs IS NOT NULL THEN
    RAISE EXCEPTION 'anon-sequence-sweep: postgres default privilege for SEQUENCES in schema public still grants anon %; the ALTER DEFAULT PRIVILEGES REVOKE above did not take, or something re-granted it since', v_privs::text;
  END IF;

  -- e) anon still holds its two legitimate INSERT paths, unchanged by this file.
  IF NOT has_table_privilege('anon', 'public.waitlist', 'INSERT') THEN
    RAISE EXCEPTION 'anon-sequence-sweep: anon lost INSERT on public.waitlist; this file must never touch that grant';
  END IF;
  IF NOT has_table_privilege('anon', 'public.adapter_requests', 'INSERT') THEN
    RAISE EXCEPTION 'anon-sequence-sweep: anon lost INSERT on public.adapter_requests; this file must never touch that grant';
  END IF;

  RAISE NOTICE 'anon-sequence-sweep: all five assertions passed';
END $$;
