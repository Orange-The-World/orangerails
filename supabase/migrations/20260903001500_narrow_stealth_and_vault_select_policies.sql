-- Narrow six SELECT policies from TO public to TO authenticated on the stealth
-- and vault tables.
--
-- THE REQUIREMENT
--
-- Six tables in this schema still hold a table level SELECT grant for the
-- anonymous role after the unpoliced grant sweep, and they hold it correctly:
-- the sweep only removes a grant that NO policy admits, and on these six a
-- SELECT policy really does admit the anonymous role. It admits it through the
-- PUBLIC branch. The policy is written TO public rather than to a named role,
-- so it applies to every role that can reach the table, and the only thing
-- standing between an anonymous session and a row is a null auth.uid() inside
-- the USING clause.
--
-- That is a thinner wall than it looks. It is one expression away from being
-- wrong, and an expression is exactly the kind of thing a later migration
-- rewrites. Naming the role makes the policy not APPLY to an anonymous
-- session at all, which is a property of the policy rather than a property of
-- a predicate somebody might edit.
--
-- Three other tables also keep anon SELECT and are deliberately NOT in this
-- file: exchange_rates, exchange_rate_resolutions and quiltt_institutions_cache
-- are genuine public reads and must stay TO public.
--
-- MEASURED STATE, read off pg_policy and pg_class on the dev project
-- (fzwmnzmtqidumdqjdddz) on 2026-09-02 while writing this file. Policy names
-- below are the names as they exist there, not names carried over from a
-- ticket.
--
--   table                 policy                                                 cmd  roles
--   stealth_connections   Owners can read their stealth connections              r    {0}
--   stealth_scan_ranges   Owners can read their stealth scan ranges              r    {0}
--   stealth_transactions  Owners can read their stealth transactions             r    {0}
--   stealth_utxos         owner read via connection                              r    {0}
--   workspace_admins      workspace_admins: owner and admin can read their rows  r    {0}
--   wrapped_data_keys     Recipients can read their own wrapped data keys        r    {0}
--
-- All six are permissive, all six are the only SELECT policy on their table,
-- and no other policy on the same table shares a name, so ALTER POLICY (which
-- is per name per table) is unambiguous. All six USING clauses key off
-- auth.uid():
--
--   stealth_connections   (auth.uid())::text = app_user_id
--   stealth_scan_ranges   EXISTS (... sc.app_user_id = (auth.uid())::text)
--   stealth_transactions  EXISTS (... (auth.uid())::text = sc.app_user_id)
--   stealth_utxos         EXISTS (... sc.app_user_id = (auth.uid())::text)
--   workspace_admins      owner_user_id = auth.uid() OR admin_user_id = auth.uid()
--   wrapped_data_keys     recipient_user_id = auth.uid()
--
-- WHAT THIS DOES NOT BREAK, checked rather than assumed
--
-- The grantees on these six tables are anon, authenticated, service_role and,
-- on five of the six, or_agent_reader. service_role and or_agent_reader both
-- carry rolbypassrls = true, so row level security policies do not apply to
-- either of them and naming a role in a policy cannot take visibility away
-- from them. No other role holds a grant on these tables, so there is no
-- worker or service path relying on the TO public branch. Read off pg_roles
-- and pg_class.relacl on dev, not inferred from how the code is written.
--
-- A SESSION WHOSE TOKEN EXPIRED MID REQUEST. It arrives with no valid token
-- and is therefore the anonymous role for that request. Before this file it
-- matched the policy and then read zero rows, because auth.uid() is null and
-- the comparison is null. After this file the policy does not apply to it and
-- it reads zero rows. The outcome is identical and, importantly, so is the
-- SHAPE of the outcome: the table level SELECT grant is untouched by this
-- file, so the request is still an empty result set rather than a permission
-- denied error. A client that treats an empty list and an error differently
-- sees no change.
--
-- FOUR POLICIES ON THESE TABLES ARE STILL TO PUBLIC AFTER THIS FILE, AND THAT
-- IS DELIBERATE. workspace_admins and wrapped_data_keys each carry an INSERT
-- and a DELETE policy that are also written TO public. They are out of scope
-- here: this file narrows READ, and the anonymous role holds SELECT and
-- nothing else on all six tables, so those four policies are unreachable by it
-- for want of a privilege. They are asserted below by name rather than ignored,
-- so a seventh TO public policy appearing on one of these tables raises here
-- instead of passing silently.
--
-- ORDER. This file must be applied after the anon unpoliced grant revoke
-- (20260903000000). That file asserts the set of tables where the anonymous
-- role still holds table level SELECT, and these six are named in it. This
-- file changes a policy and not a grant, so that assertion holds either way,
-- but the order is fixed so that if either self check raises it is obvious
-- which file caused it. The timestamp is what enforces it, so do not renumber
-- this file below 20260903000000.
--
-- ---------------------------------------------------------------------------
-- PORTABILITY. EVERY STATEMENT IS GUARDED ON THE TABLE EXISTING, AND THE
-- EXPECTED SETS ARE BUILT FROM WHAT THE CLUSTER ACTUALLY HOLDS.
-- ---------------------------------------------------------------------------
--
-- The table list above was measured on ONE cluster, and the two clusters do
-- not hold the same set of tables. Measured against the production cluster on
-- 2026-09-02: to_regclass('public.stealth_utxos') returns null there, so that
-- table does not exist, while the other five tables in this file do exist and
-- each carries a policy under exactly the name used here, all still addressed
-- to public. Twenty one tables differ between the two clusters in total, so
-- this is a standing condition and not a one off.
--
-- PostgreSQL has no ALTER POLICY ... IF EXISTS form, so the statement cannot be
-- guarded inline and a bare ALTER POLICY on an absent table raises 42P01. The
-- deploy applies migration files one at a time in version order and exits on
-- the first failure, so a single unguarded statement here would leave the
-- production cluster with every earlier file in the batch applied and every
-- later one not: a partially applied schema, and a policy baseline that no
-- longer matches the cluster it describes. Each ALTER POLICY is therefore
-- wrapped in a to_regclass check that raises a NOTICE when it skips, so a skip
-- is visible in the deploy log rather than silent.
--
-- Guarding the statements is not enough on its own, and this is the part that
-- is easy to miss. The self checks below are still EXACT SET equalities, which
-- is the whole point of them: an absence test passes while something new and
-- unnoticed appears next to what it checked. But the expected sets are now
-- BUILT from the tables present on the cluster instead of written out as
-- string literals. A literal would demand a member that can never appear where
-- the table is absent, so the assertion would raise there even with every
-- statement correctly guarded. Built this way the assertion still proves an
-- exact set on each cluster, which is the property worth keeping.
--
-- WHY THE ASSERTIONS READ pg_class.relname RATHER THAN polrelid::regclass::text.
-- The text form of a regclass omits the schema only when that schema is on the
-- search path, so the same query answers stealth_utxos on one connection and
-- public.stealth_utxos on another. The deploy applies this file over the
-- management API and does not set a search path, so the comparison is made
-- against pg_class.relname with the namespace named explicitly instead. This
-- is a portability fix in the same class as the guards: it removes a dependency
-- on the session that runs the file.
--
-- THIS FILE DOES NOT CREATE stealth_utxos WHERE IT IS MISSING. Creating a table
-- on a cluster in order to satisfy a policy migration is a schema change
-- wearing a bug fix costume. 20260504000000_stealth_sync, which both clusters
-- have applied, creates only stealth_connections and stealth_transactions, so
-- it is not the origin of this table, and no file in the pending backlog
-- creates it either. Where it came from is not understood well enough to
-- reproduce, and answering that is separate work.
--
-- ROLLBACK. Run only the lines whose table exists on the cluster you are
-- rolling back, for exactly the reason above.
--
--   ALTER POLICY "Owners can read their stealth connections"
--     ON public.stealth_connections TO public;
--   ALTER POLICY "Owners can read their stealth scan ranges"
--     ON public.stealth_scan_ranges TO public;
--   ALTER POLICY "Owners can read their stealth transactions"
--     ON public.stealth_transactions TO public;
--   ALTER POLICY "owner read via connection"
--     ON public.stealth_utxos TO public;
--   ALTER POLICY "workspace_admins: owner and admin can read their rows"
--     ON public.workspace_admins TO public;
--   ALTER POLICY "Recipients can read their own wrapped data keys"
--     ON public.wrapped_data_keys TO public;

DO $$ BEGIN
  IF to_regclass('public.stealth_connections') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.stealth_connections not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "Owners can read their stealth connections" ON public.stealth_connections TO authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.stealth_scan_ranges') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.stealth_scan_ranges not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "Owners can read their stealth scan ranges" ON public.stealth_scan_ranges TO authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.stealth_transactions') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.stealth_transactions not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "Owners can read their stealth transactions" ON public.stealth_transactions TO authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.stealth_utxos') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.stealth_utxos not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "owner read via connection" ON public.stealth_utxos TO authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.workspace_admins') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.workspace_admins not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "workspace_admins: owner and admin can read their rows" ON public.workspace_admins TO authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.wrapped_data_keys') IS NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: public.wrapped_data_keys not present, skipped';
  ELSE
    EXECUTE 'ALTER POLICY "Recipients can read their own wrapped data keys" ON public.wrapped_data_keys TO authenticated';
  END IF;
END $$;

-- Self check. Both halves are EQUALITIES rather than absence tests. An absence
-- test passes while something new and unnoticed appears next to what it
-- checked, which is the failure this whole series of migrations exists to
-- catch. The expected sides are built from the tables this cluster holds, so
-- the equality is still exact where a table is missing rather than being
-- weakened into an "at least" test.
DO $$
DECLARE
  six CONSTANT text[] := ARRAY[
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'stealth_utxos','workspace_admins','wrapped_data_keys'];
  -- The six read policies this file narrows, and the four write policies it
  -- deliberately leaves addressed to public, as table|policy pairs so that the
  -- expected sets can be filtered by what is present. The pairs are written out
  -- literally on purpose: they are a measurement, and this must never become a
  -- query over whatever policies happen to exist, which would assert nothing.
  read_policies CONSTANT text[] := ARRAY[
    'stealth_connections|Owners can read their stealth connections',
    'stealth_scan_ranges|Owners can read their stealth scan ranges',
    'stealth_transactions|Owners can read their stealth transactions',
    'stealth_utxos|owner read via connection',
    'workspace_admins|workspace_admins: owner and admin can read their rows',
    'wrapped_data_keys|Recipients can read their own wrapped data keys'];
  write_policies CONSTANT text[] := ARRAY[
    'workspace_admins|workspace_admins: owner can delete',
    'workspace_admins|workspace_admins: owner can insert',
    'wrapped_data_keys|wrapped_data_keys: owner can delete their wrapped keys',
    'wrapped_data_keys|wrapped_data_keys: owner can insert for admins'];
  expected_authenticated text;
  expected_public text;
  absent text;
  actual text;
BEGIN
  -- 0. Say out loud which of the six this cluster does not have. Everything
  --    below is scoped to what is present, so a reader of the deploy log needs
  --    to be able to see what was excluded and why the sets are shorter.
  SELECT string_agg(t, ', ' ORDER BY t) INTO absent
    FROM unnest(six) AS s(t)
   WHERE to_regclass('public.' || t) IS NULL;

  IF absent IS NOT NULL THEN
    RAISE NOTICE 'stealth and vault policy narrowing: table(s) not present on this cluster, so they were skipped above and are excluded from the assertions below: %', absent;
  END IF;

  SELECT coalesce(string_agg(e, ', ' ORDER BY split_part(e, '|', 1), split_part(e, '|', 2)), 'NONE')
    INTO expected_authenticated
    FROM unnest(read_policies) AS r(e)
   WHERE to_regclass('public.' || split_part(e, '|', 1)) IS NOT NULL;

  SELECT coalesce(string_agg(e, ', ' ORDER BY split_part(e, '|', 1), split_part(e, '|', 2)), 'NONE')
    INTO expected_public
    FROM unnest(write_policies) AS w(e)
   WHERE to_regclass('public.' || split_part(e, '|', 1)) IS NOT NULL;

  -- 1. Every policy on these six tables that is still TO public must be one of
  --    the four write policies named above. Six read policies moved; nothing
  --    else on these tables may be addressed to public.
  SELECT coalesce(string_agg(c.relname || '|' || p.polname, ', ' ORDER BY c.relname, p.polname), 'NONE')
    INTO actual
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname = ANY(six)
     AND p.polroles = '{0}'::oid[];

  IF actual IS DISTINCT FROM expected_public THEN
    RAISE EXCEPTION
      'stealth and vault tables: policies still addressed to public are [%], expected exactly [%]',
      actual, expected_public;
  END IF;

  -- 2. The policies now addressed to the logged in role must be exactly the
  --    ones this file names ON THE TABLES THIS CLUSTER HAS. Not "at least": a
  --    set comparison also catches a policy somebody else narrowed, or one
  --    added under a name nobody here knows.
  SELECT coalesce(string_agg(c.relname || '|' || p.polname, ', ' ORDER BY c.relname, p.polname), 'NONE')
    INTO actual
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname = ANY(six)
     AND p.polroles = ARRAY['authenticated'::regrole::oid];

  IF actual IS DISTINCT FROM expected_authenticated THEN
    RAISE EXCEPTION
      'stealth and vault tables: policies addressed to authenticated are [%], expected exactly [%]',
      actual, expected_authenticated;
  END IF;

  -- 3. Those policies must still be permissive SELECT policies. Narrowing the
  --    role is not allowed to have changed anything else about them, and a
  --    restrictive policy grants nothing at all, so this is not a formality.
  SELECT coalesce(string_agg(c.relname || '|' || p.polname, ', ' ORDER BY c.relname, p.polname), 'NONE')
    INTO actual
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relname = ANY(six)
     AND p.polroles = ARRAY['authenticated'::regrole::oid]
     AND p.polcmd = 'r'
     AND p.polpermissive;

  IF actual IS DISTINCT FROM expected_authenticated THEN
    RAISE EXCEPTION
      'stealth and vault tables: the narrowed policies are no longer all permissive SELECT policies, found [%]',
      actual;
  END IF;

  -- 4. The anonymous role must still hold SELECT and nothing more on these six.
  --    This is what makes leaving four TO public write policies in place safe:
  --    they are unreachable for want of a privilege. If that ever stops being
  --    true, this file is the wrong shape and should say so out loud. A table
  --    that is not present simply does not match, so this needs no guard.
  --
  --    BOTH CATALOGUES, AND IT HAS TO BE BOTH. A privilege can be granted on a
  --    table, which lands in pg_class.relacl, or on named columns of it, which
  --    lands in pg_attribute.attacl and does NOT appear in relacl at all. An
  --    earlier version of this check read relacl only, so a column scoped
  --    INSERT on one of these six would have left a TO public write policy
  --    reachable while this assertion still printed NONE. That is not a remote
  --    shape on this schema: wrapped_data_keys already carries column scoped
  --    SELECT grants today, and column scoped INSERT and UPDATE are an idiom
  --    this tree uses elsewhere.
  --
  --    Only INSERT and UPDATE can actually arrive by the column route, because
  --    PostgreSQL has no column level DELETE, so the two DELETE policies left
  --    addressed to public are not reachable this way. The leg is written for
  --    any non SELECT privilege regardless, so it needs no revisiting.
  SELECT coalesce(string_agg(DISTINCT g, ', '), 'NONE') INTO actual
    FROM (
      SELECT c.relname || ':' || a.privilege_type AS g
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace,
             aclexplode(c.relacl) a
       WHERE ns.nspname = 'public'
         AND c.relname = ANY(six)
         AND a.grantee = 'anon'::regrole
         AND a.privilege_type <> 'SELECT'
      UNION ALL
      SELECT c.relname || '.' || att.attname || ':' || a.privilege_type AS g
        FROM pg_attribute att
        JOIN pg_class c ON c.oid = att.attrelid
        JOIN pg_namespace ns ON ns.oid = c.relnamespace,
             aclexplode(att.attacl) a
       WHERE ns.nspname = 'public'
         AND c.relname = ANY(six)
         AND att.attacl IS NOT NULL
         AND att.attnum > 0
         AND NOT att.attisdropped
         AND a.grantee = 'anon'::regrole
         AND a.privilege_type <> 'SELECT'
    ) both_catalogues;

  IF actual <> 'NONE' THEN
    RAISE EXCEPTION
      'stealth and vault tables: the anonymous role holds more than SELECT [%] (table.column form means a column scoped grant), so the write policies left addressed to public are reachable',
      actual;
  END IF;

  -- 5. The paths that must keep reading these tables do not depend on this
  --    change at all, and the reason is that they bypass row level security.
  --    If that ever stops being true for either role, narrowing a policy DOES
  --    take rows away from them and this check is where that is discovered.
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'service_role no longer bypasses row level security, so narrowing these policies can hide rows from the server side path';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader')
     AND NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'or_agent_reader') THEN
    RAISE EXCEPTION
      'or_agent_reader no longer bypasses row level security, so narrowing these policies can hide rows from the restricted read role';
  END IF;

  RAISE NOTICE 'stealth and vault policy narrowing: end state verified. The read policies on every one of the six tables this cluster holds are addressed to authenticated and are still permissive SELECT policies, the only policies left addressed to public on those tables are the four write policies, and the anonymous role holds SELECT and nothing more.';
END $$;
