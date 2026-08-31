-- Object level drift fingerprint.
--
-- Run this on two clusters and diff the two outputs. Any difference is drift:
-- either an object that exists on one cluster and not the other, or the same
-- object carrying a different property.
--
-- USAGE
--   psql "$DEV_URL"  -v ON_ERROR_STOP=1 -f scripts/db/object-drift-fingerprint.sql \
--        > /tmp/dev.out  2> /tmp/dev.err  ; echo "dev  exit=$?"
--   psql "$PROD_URL" -v ON_ERROR_STOP=1 -f scripts/db/object-drift-fingerprint.sql \
--        > /tmp/prod.out 2> /tmp/prod.err ; echo "prod exit=$?"
--
--   Before you diff, check all three of these. Any one of them failing means the
--   run proved nothing, and a diff of two useless artifacts looks exactly like
--   agreement:
--     1. both exit codes are 0
--     2. both .out files contain a line reading guard=passed
--     3. both .err files are empty
--   Only then:
--   diff -u /tmp/dev.out /tmp/prod.out
--
-- WHY THE INVOCATION IS SPELLED OUT LIKE THAT
--   psql without ON_ERROR_STOP continues past a statement that RAISEs and still
--   exits 0. An earlier version of this file documented exactly that, so the
--   zero-count guard below would fire, stop nothing, leave the exit status at 0,
--   and its message would not even appear in the artifact being diffed, because
--   RAISE writes to stderr and only stdout was redirected. The guard existed and
--   was unreachable.
--   It is now defended three times over, so that no single omission disarms it:
--     the script sets ON_ERROR_STOP itself on the first line below, so a caller
--     who forgets the flag is still protected;
--     the flag stays in the documented command as well, so the two cannot drift;
--     and the guard writes guard=passed to STDOUT, so an artifact missing that
--     line is a failed run even if the exit code was thrown away.
--
-- WHY OBJECTS AND NOT LEDGER ROWS
--   A check that compares migration ledger rows to version prefixes in the
--   migration tree can only see a version with no row. It cannot see an object
--   that is present with no row behind it, which is the drift we actually have,
--   and it cannot see two clusters that have diverged.
--
-- ONE SOURCE, AND IT IS pg_catalog
--   Every kind reads pg_catalog. Nothing here reads information_schema, for two
--   separate reasons, either of which is enough:
--     information_schema does not cover materialized views at all. Measured on
--     our own clusters, both connected as postgres, prod returned 610 columns
--     through information_schema and 630 through pg_catalog. All 20 of the
--     difference were public.orbi_pair_inventory_strength, a materialized view.
--     information_schema also restricts rows to objects the current role holds
--     some privilege on, so two runs made as different roles differ with no
--     drift present.
--   Both failures produce an UNDER-count rather than a zero, which is the
--   dangerous shape: the guard below only fires at zero, so it cannot catch
--   either one. The fix is to never read the filtered source, not to guard it.
--
-- WHAT IS IN THE FINGERPRINT, AND WHY EACH ONE EARNED ITS PLACE
--   column      type, nullability, default, identity and generated. A column
--               added out of band, or added by ADD COLUMN IF NOT EXISTS over an
--               existing column whose default differs, is invisible to any
--               shape-only comparison.
--   function    proconfig, prosecdef and proacl. A search_path pin lives in
--               proconfig, not in the function body, and a security definer
--               function with no pin is a different object from one with a pin.
--               proacl is the execute grant, the same class of privilege the
--               vault table revoke work is about.
--   trigger     tgenabled. THIS IS THE IMPORTANT ONE. The enable state is not
--               part of pg_get_triggerdef, so a guard can be disabled while its
--               definition still reads correct and every shape check passes.
--               O = origin (bypassable under session_replication_role=replica)
--               D = disabled, R = replica, A = always (not bypassable).
--   policy      command, permissive flag, roles, and the USING and WITH CHECK
--               expressions. Roles and command alone say a policy exists and
--               who it names; only the expressions say what it actually admits,
--               and a policy quietly widened is an access change with no schema
--               shape change at all.
--   acl_rls     relacl plus relrowsecurity and relforcerowsecurity. Grants have
--               been observed differing between clusters with no migration
--               explaining it, and RLS that is enabled but not forced exempts
--               the table owner, which is not visible from the policy list.
--   constraint  contype, convalidated and the definition. A constraint added
--               NOT VALID looks exactly like a validated one until you read
--               convalidated, and a NOT VALID constraint never checked the rows
--               already there. The definition catches a CHECK whose expression
--               changed while its name did not.
--   index       indisunique, indisprimary, indisvalid, the partial predicate
--               and the definition. indisvalid is here for the same reason
--               tgenabled and convalidated are: an index left invalid by a
--               failed CREATE INDEX CONCURRENTLY exists, reads correct in every
--               shape check, and is silently ignored by the planner.
--
-- IT MUST BE ABLE TO FAIL
--   The standing defect here is a check that exits 0 because it processed
--   nothing. An empty fingerprint compared to an empty fingerprint reads as
--   agreement. So this RAISES when any kind fingerprints to zero objects, and
--   it prints the count for every kind, so "compared nothing" and "found
--   nothing wrong" can never look the same in the output.
--
-- WHAT THIS STILL CANNOT DO
--   It compares a cluster to a cluster. It tells you the two disagree; it does
--   not tell you which one is wrong, and it cannot tell you an object has no
--   file behind it. Two clusters carrying the same unbacked object read as
--   identical here. Comparing a cluster against a schema replayed from the
--   migration tree is the other half, and it is tracked separately.

\set ON_ERROR_STOP on
\pset pager off
\pset format aligned

CREATE OR REPLACE FUNCTION pg_temp.drift_sigs()
RETURNS TABLE (kind text, sig text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT 'column',
         'col|'||cl.relname||'.'||a.attname
              ||'|'||format_type(a.atttypid, a.atttypmod)
              ||'|notnull='||a.attnotnull::text
              ||'|default='||coalesce(pg_get_expr(ad.adbin, ad.adrelid),'-')
              ||'|identity='||CASE a.attidentity WHEN 'a' THEN 'always'
                                                 WHEN 'd' THEN 'default'
                                                 ELSE '-' END
              ||'|generated='||CASE a.attgenerated WHEN 's' THEN 'stored'
                                                   ELSE '-' END
    FROM pg_attribute a
    JOIN pg_class cl        ON cl.oid = a.attrelid
    JOIN pg_namespace n     ON n.oid = cl.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND cl.relkind IN ('r','p','v','m')
     AND a.attnum > 0
     AND NOT a.attisdropped
  UNION ALL
  SELECT 'function',
         'fn|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'
              ||coalesce(array_to_string(p.proconfig,','),'-')
              ||'|secdef='||p.prosecdef::text
              ||'|acl='||coalesce(p.proacl::text,'-')
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
         'pol|'||cl.relname||'.'||pol.polname
              ||'|cmd='||CASE pol.polcmd WHEN '*' THEN 'ALL'
                                         WHEN 'r' THEN 'SELECT'
                                         WHEN 'a' THEN 'INSERT'
                                         WHEN 'w' THEN 'UPDATE'
                                         WHEN 'd' THEN 'DELETE'
                                         ELSE pol.polcmd::text END
              ||'|permissive='||pol.polpermissive::text
              ||'|roles='||coalesce(
                   (SELECT string_agg(q.rn, ',' ORDER BY q.rn)
                      FROM (SELECT CASE WHEN r = 0 THEN 'public'
                                        ELSE pg_get_userbyid(r) END AS rn
                              FROM unnest(pol.polroles) AS r) q), '-')
              ||'|using='||coalesce(pg_get_expr(pol.polqual, pol.polrelid),'-')
              ||'|check='||coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'-')
    FROM pg_policy pol
    JOIN pg_class cl     ON cl.oid = pol.polrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
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
         'con|'||cl.relname||'.'||con.conname||'|'||con.contype::text
              ||'|valid='||con.convalidated::text
              ||'|def='||pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class cl     ON cl.oid = con.conrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index',
         'idx|'||tc.relname||'.'||ic.relname
              ||'|unique='||i.indisunique::text
              ||'|primary='||i.indisprimary::text
              ||'|valid='||i.indisvalid::text
              ||'|ready='||i.indisready::text
              ||'|pred='||coalesce(pg_get_expr(i.indpred, i.indrelid),'-')
              ||'|def='||pg_get_indexdef(i.indexrelid)
    FROM pg_index i
    JOIN pg_class ic     ON ic.oid = i.indexrelid
    JOIN pg_class tc     ON tc.oid = i.indrelid
    JOIN pg_namespace n  ON n.oid = tc.relnamespace
   WHERE n.nspname = 'public';
$fn$;

-- Take the snapshot ONCE. The guard, the summary and the detail all read this
-- one table, so they cannot end up describing three different moments of a
-- cluster that is being written to while the script runs.
DROP TABLE IF EXISTS pg_temp.drift_out;
CREATE TEMP TABLE drift_out AS SELECT * FROM pg_temp.drift_sigs();

-- The guard. A kind that fingerprints to zero is a check that could not run,
-- not a cluster with nothing to check. Fail loudly rather than print a tidy
-- empty table that diffs clean against another tidy empty table.
DO $guard$
DECLARE
  v_expected text[] := ARRAY['column','function','trigger','policy','acl_rls','constraint','index'];
  v_kind     text;
  v_missing  text := '';
  v_total    integer;
  v_kinds    integer;
BEGIN
  SELECT count(*) INTO v_total FROM pg_temp.drift_out;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'drift fingerprint compared NOTHING: 0 objects in schema public. This is a failed check, not a clean cluster.';
  END IF;

  FOREACH v_kind IN ARRAY v_expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_temp.drift_out s WHERE s.kind = v_kind) THEN
      v_missing := v_missing || v_kind || ' ';
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'drift fingerprint produced ZERO objects for kind(s): %. A kind that fingerprints to nothing cannot be compared, so this run proves nothing.', v_missing;
  END IF;

  -- A kind added to the query and not to v_expected would go unguarded, and a
  -- kind removed from the query would be caught above. This catches the first.
  SELECT count(DISTINCT kind) INTO v_kinds FROM pg_temp.drift_out;
  IF v_kinds <> array_length(v_expected, 1) THEN
    RAISE EXCEPTION 'drift fingerprint produced % kind(s) but the guard list names %. The query and the guard have drifted apart, so this run is not guarded.',
      v_kinds, array_length(v_expected, 1);
  END IF;

  RAISE NOTICE 'drift fingerprint: % objects across % kinds, guard passed', v_total, v_kinds;
END
$guard$;

-- The guard result, on STDOUT. RAISE NOTICE above goes to stderr, which is easy
-- to lose. This line is the one that ends up in the diffed artifact, so its
-- ABSENCE is itself the failure signal.
\echo '=== GUARD (this line must be present: no guard row means the run failed) ==='
SELECT 'guard=passed'       AS guard,
       count(*)             AS objects_compared,
       count(DISTINCT kind) AS kinds_compared
  FROM pg_temp.drift_out;

-- Summary. Read this first: it says what was compared. Two clusters whose
-- summaries are identical line for line have identical public schemas as far
-- as this fingerprint reaches.
\echo '=== SUMMARY (counts and digests) ==='
SELECT kind,
       count(*)                                    AS objects,
       md5(string_agg(sig, E'\n' ORDER BY sig))    AS digest
  FROM pg_temp.drift_out
 GROUP BY kind
UNION ALL
SELECT 'ALL', count(*), md5(string_agg(sig, E'\n' ORDER BY sig))
  FROM pg_temp.drift_out
 ORDER BY 1;

-- Detail. Diff this half between two clusters to see WHICH objects differ.
\echo '=== DETAIL (one line per object, sorted) ==='
SELECT sig FROM pg_temp.drift_out ORDER BY sig;
