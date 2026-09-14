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
-- ROLLBACK
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

ALTER POLICY "Owners can read their stealth connections"
  ON public.stealth_connections TO authenticated;

ALTER POLICY "Owners can read their stealth scan ranges"
  ON public.stealth_scan_ranges TO authenticated;

ALTER POLICY "Owners can read their stealth transactions"
  ON public.stealth_transactions TO authenticated;

ALTER POLICY "owner read via connection"
  ON public.stealth_utxos TO authenticated;

ALTER POLICY "workspace_admins: owner and admin can read their rows"
  ON public.workspace_admins TO authenticated;

ALTER POLICY "Recipients can read their own wrapped data keys"
  ON public.wrapped_data_keys TO authenticated;

-- Self check. Both halves are EQUALITIES rather than absence tests. An absence
-- test passes while something new and unnoticed appears next to what it
-- checked, which is the failure this whole series of migrations exists to
-- catch.
DO $$
DECLARE
  six CONSTANT text[] := ARRAY[
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'stealth_utxos','workspace_admins','wrapped_data_keys'];
  expected_authenticated CONSTANT text :=
    'stealth_connections|Owners can read their stealth connections, '
    'stealth_scan_ranges|Owners can read their stealth scan ranges, '
    'stealth_transactions|Owners can read their stealth transactions, '
    'stealth_utxos|owner read via connection, '
    'workspace_admins|workspace_admins: owner and admin can read their rows, '
    'wrapped_data_keys|Recipients can read their own wrapped data keys';
  expected_public CONSTANT text :=
    'workspace_admins|workspace_admins: owner can delete, '
    'workspace_admins|workspace_admins: owner can insert, '
    'wrapped_data_keys|wrapped_data_keys: owner can delete their wrapped keys, '
    'wrapped_data_keys|wrapped_data_keys: owner can insert for admins';
  actual text;
BEGIN
  -- 1. Every policy on these six tables that is still TO public must be one of
  --    the four write policies named above. Six read policies moved; nothing
  --    else on these tables may be addressed to public.
  SELECT coalesce(string_agg(t || '|' || n, ', ' ORDER BY t, n), 'NONE') INTO actual
    FROM (SELECT p.polrelid::regclass::text AS t, p.polname AS n
            FROM pg_policy p
           WHERE p.polrelid::regclass::text = ANY(six)
             AND p.polroles = '{0}'::oid[]) s;

  IF actual IS DISTINCT FROM expected_public THEN
    RAISE EXCEPTION
      'stealth and vault tables: policies still addressed to public are [%], expected exactly [%]',
      actual, expected_public;
  END IF;

  -- 2. The policies now addressed to the logged in role must be exactly the six
  --    this file names. Not "at least": a set comparison also catches a policy
  --    somebody else narrowed, or one added under a name nobody here knows.
  SELECT coalesce(string_agg(t || '|' || n, ', ' ORDER BY t, n), 'NONE') INTO actual
    FROM (SELECT p.polrelid::regclass::text AS t, p.polname AS n
            FROM pg_policy p
           WHERE p.polrelid::regclass::text = ANY(six)
             AND p.polroles = ARRAY['authenticated'::regrole::oid]) s;

  IF actual IS DISTINCT FROM expected_authenticated THEN
    RAISE EXCEPTION
      'stealth and vault tables: policies addressed to authenticated are [%], expected exactly [%]',
      actual, expected_authenticated;
  END IF;

  -- 3. The six must still be permissive SELECT policies. Narrowing the role is
  --    not allowed to have changed anything else about them, and a restrictive
  --    policy grants nothing at all, so this is not a formality.
  SELECT coalesce(string_agg(t || '|' || n, ', ' ORDER BY t, n), 'NONE') INTO actual
    FROM (SELECT p.polrelid::regclass::text AS t, p.polname AS n
            FROM pg_policy p
           WHERE p.polrelid::regclass::text = ANY(six)
             AND p.polroles = ARRAY['authenticated'::regrole::oid]
             AND p.polcmd = 'r'
             AND p.polpermissive) s;

  IF actual IS DISTINCT FROM expected_authenticated THEN
    RAISE EXCEPTION
      'stealth and vault tables: the six narrowed policies are no longer all permissive SELECT policies, found [%]',
      actual;
  END IF;

  -- 4. The anonymous role must still hold SELECT and nothing more on these six.
  --    This is what makes leaving four TO public write policies in place safe:
  --    they are unreachable for want of a privilege. If that ever stops being
  --    true, this file is the wrong shape and should say so out loud.
  SELECT coalesce(string_agg(DISTINCT c.relname || ':' || a.privilege_type, ', '), 'NONE') INTO actual
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace,
         aclexplode(c.relacl) a
   WHERE ns.nspname = 'public'
     AND c.relname = ANY(six)
     AND a.grantee = 'anon'::regrole
     AND a.privilege_type <> 'SELECT';

  IF actual <> 'NONE' THEN
    RAISE EXCEPTION
      'stealth and vault tables: the anonymous role holds more than SELECT [%], so the write policies left addressed to public are reachable',
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
END $$;
