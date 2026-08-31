-- Object level drift fingerprint.
--
-- Run this on two clusters and diff the two outputs. Any difference is drift:
-- either an object that exists on one cluster and not the other, or the same
-- object carrying a different property.
--
-- USAGE
--   psql "$DEV_URL"  -f scripts/db/object-drift-fingerprint.sql > /tmp/dev.txt
--   psql "$PROD_URL" -f scripts/db/object-drift-fingerprint.sql > /tmp/prod.txt
--   diff -u /tmp/dev.txt /tmp/prod.txt
--
-- WHY OBJECTS AND NOT LEDGER ROWS
--   A check that compares migration ledger rows to version prefixes in the
--   migration tree can only see a version with no row. It cannot see an object
--   that is present with no row behind it, which is the drift we actually have,
--   and it cannot see two clusters that have diverged.
--
-- WHAT IS IN THE FINGERPRINT, AND WHY EACH ONE EARNED ITS PLACE
--   column      type, nullability and default. A column added out of band, or
--               added by ADD COLUMN IF NOT EXISTS over an existing column whose
--               default differs, is invisible to any shape-only comparison.
--   function    proconfig and prosecdef. A search_path pin lives in proconfig,
--               not in the function body, and a security definer function with
--               no pin is a different object from one with a pin.
--   trigger     tgenabled. THIS IS THE IMPORTANT ONE. The enable state is not
--               part of pg_get_triggerdef, so a guard can be disabled while its
--               definition still reads correct and every shape check passes.
--               O = origin (bypassable under session_replication_role=replica)
--               D = disabled, R = replica, A = always (not bypassable).
--   policy      command and roles. A policy narrowed or widened silently is a
--               access change with no schema shape change.
--   acl_rls     relacl plus relrowsecurity and relforcerowsecurity. Grants have
--               been observed differing between clusters with no migration
--               explaining it, and RLS that is enabled but not forced exempts
--               the table owner, which is not visible from the policy list.
--   constraint  contype and convalidated. A constraint added NOT VALID looks
--               exactly like a validated one until you read convalidated, and
--               a NOT VALID constraint never checked the rows already there.
--
-- IT MUST BE ABLE TO FAIL
--   The standing defect here is a check that exits 0 because it processed
--   nothing. An empty fingerprint compared to an empty fingerprint reads as
--   agreement. So this RAISES when any kind fingerprints to zero objects, and
--   it prints the count for every kind, so "compared nothing" and "found
--   nothing wrong" can never look the same in the output.

\pset pager off
\pset format aligned

CREATE OR REPLACE FUNCTION pg_temp.drift_sigs()
RETURNS TABLE (kind text, sig text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT 'column',
         'col|'||c.table_name||'.'||c.column_name||'|'||c.data_type||'|'
              ||c.is_nullable||'|'||coalesce(c.column_default,'-')
    FROM information_schema.columns c
    JOIN pg_class pc     ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
   WHERE c.table_schema = 'public'
     AND pc.relkind IN ('r','p','v','m')
  UNION ALL
  SELECT 'function',
         'fn|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'
              ||coalesce(array_to_string(p.proconfig,','),'-')||'|secdef='||p.prosecdef::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'trigger',
         'tg|'||cl.relname||'.'||t.tgname||'|enabled='||t.tgenabled::text
    FROM pg_trigger t
    JOIN pg_class cl     ON cl.oid = t.tgrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
     AND NOT t.tgisinternal
  UNION ALL
  SELECT 'policy',
         'pol|'||pol.tablename||'.'||pol.policyname||'|'||pol.cmd||'|'
              ||coalesce(array_to_string(pol.roles,','),'-')
    FROM pg_policies pol
   WHERE pol.schemaname = 'public'
  UNION ALL
  SELECT 'acl_rls',
         'acl|'||cl.relname||'|'||coalesce(cl.relacl::text,'-')
              ||'|rls='||cl.relrowsecurity::text||'|force='||cl.relforcerowsecurity::text
    FROM pg_class cl
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
     AND cl.relkind IN ('r','p')
  UNION ALL
  SELECT 'constraint',
         'con|'||cl.relname||'.'||con.conname||'|'||con.contype::text||'|valid='||con.convalidated::text
    FROM pg_constraint con
    JOIN pg_class cl     ON cl.oid = con.conrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public';
$fn$;

-- The guard. A kind that fingerprints to zero is a check that could not run,
-- not a cluster with nothing to check. Fail loudly rather than print a tidy
-- empty table that diffs clean against another tidy empty table.
DO $guard$
DECLARE
  v_kind    text;
  v_missing text := '';
  v_total   integer;
BEGIN
  SELECT count(*) INTO v_total FROM pg_temp.drift_sigs();
  IF v_total = 0 THEN
    RAISE EXCEPTION 'drift fingerprint compared NOTHING: 0 objects in schema public. This is a failed check, not a clean cluster.';
  END IF;

  FOREACH v_kind IN ARRAY ARRAY['column','function','trigger','policy','acl_rls','constraint'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_temp.drift_sigs() s WHERE s.kind = v_kind) THEN
      v_missing := v_missing || v_kind || ' ';
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'drift fingerprint produced ZERO objects for kind(s): %. A kind that fingerprints to nothing cannot be compared, so this run proves nothing.', v_missing;
  END IF;

  RAISE NOTICE 'drift fingerprint: % objects across 6 kinds, guard passed', v_total;
END
$guard$;

-- Summary. Read this first: it says what was compared. Two clusters whose
-- summaries are identical line for line have identical public schemas as far
-- as this fingerprint reaches.
\echo '=== SUMMARY (counts and digests) ==='
SELECT kind,
       count(*)                                    AS objects,
       md5(string_agg(sig, E'\n' ORDER BY sig))    AS digest
  FROM pg_temp.drift_sigs()
 GROUP BY kind
UNION ALL
SELECT 'ALL', count(*), md5(string_agg(sig, E'\n' ORDER BY sig))
  FROM pg_temp.drift_sigs()
 ORDER BY 1;

-- Detail. Diff this half between two clusters to see WHICH objects differ.
\echo '=== DETAIL (one line per object, sorted) ==='
SELECT sig FROM pg_temp.drift_sigs() ORDER BY sig;
