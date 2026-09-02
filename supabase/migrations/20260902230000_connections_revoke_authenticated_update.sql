-- Remove the UPDATE privilege for authenticated on public.connections.
--
-- THE REQUIREMENT
--
-- public.connections holds server side operational values in the same row as
-- the fields the browser renders. strike_webhook_secret is one of them: it is
-- the key an inbound Strike webhook is authenticated against, so it is server
-- side only and the authenticated role must be able neither to read it nor to
-- write it.
--
-- Row level security cannot express that. A policy filters ROWS, not COLUMNS,
-- so the requirement has to be enforced as a privilege.
--
-- WHY THIS IS A FULL REVOKE AND NOT A COLUMN LIST
--
-- The browser client has no update path on this table. Enumerated at dev head
-- by reading the whole of src/routes/app.tsx, all 1788 lines, which is the
-- only client side caller of this table:
--
--   lines 459 to 463   SELECT, the connections list
--   lines 627 to 638   INSERT, the add connection path, six named columns
--   line  672          DELETE by id, discovery rejected the credentials
--   line  846          DELETE by id, the user deleted the connection
--
-- There is no UPDATE anywhere in that file. Every other writer to this table
-- runs under the service role key inside supabase/functions, and service_role
-- is a separate grantee which this file does not touch. With no legitimate
-- client column to preserve, the correct grant is none, and a revoke of the
-- whole privilege is also the only form of this that cannot drift as columns
-- are added to the table later.
--
-- THE POLICY GOES WITH THE PRIVILEGE
--
-- "Direct users can update connections via their subaccount" only ever
-- applied to UPDATE statements, so once the privilege is gone it can never be
-- reached. Dropping it is not cosmetic: it makes a later accidental re-grant
-- fail closed rather than open, because table level UPDATE with no UPDATE
-- policy updates no rows.
--
-- WHAT THIS DOES NOT TOUCH
--
-- The SELECT, INSERT and DELETE privileges and their three policies are
-- unchanged, so the list, add and delete paths keep working. Revoking one
-- privilege at table level does not disturb a column level grant of a
-- different privilege, so a column level SELECT grant on this table is
-- unaffected by this file whichever order the two land in.
--
-- ROLLBACK
--
--   GRANT UPDATE ON public.connections TO authenticated;
--   CREATE POLICY "Direct users can update connections via their subaccount"
--     ON public.connections FOR UPDATE TO authenticated
--     USING (subaccount_id IN (
--       SELECT s.id FROM subaccounts s
--         JOIN platforms p ON p.id = s.platform_id AND p.slug = 'direct'
--        WHERE s.external_user_id = (auth.uid())::text));
--
-- The rollback restores a write privilege the client does not use, so it
-- drops the requirement stated at the top of this file. It is written down
-- because a rollback path has to exist, not because it is a safe end state.

REVOKE UPDATE ON public.connections FROM authenticated;

DROP POLICY IF EXISTS "Direct users can update connections via their subaccount"
  ON public.connections;

-- Self check. This asserts the OUTCOME rather than the statements, so a
-- column added to this table later, or a grant restored by hand, is caught
-- here instead of passing silently. has_column_privilege is used rather than
-- reading attacl, because an empty attacl means "inherits the table grant",
-- which is exactly the state being removed and would read as safe.
DO $$
DECLARE
  still_writable text;
  leftover_policy text;
BEGIN
  IF has_table_privilege('authenticated', 'public.connections', 'UPDATE') THEN
    RAISE EXCEPTION
      'connections: authenticated still holds table level UPDATE';
  END IF;

  SELECT string_agg(a.attname, ', ' ORDER BY a.attname)
    INTO still_writable
    FROM pg_attribute a
   WHERE a.attrelid = 'public.connections'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('authenticated', 'public.connections', a.attname, 'UPDATE');

  IF still_writable IS NOT NULL THEN
    RAISE EXCEPTION
      'connections: authenticated can still UPDATE column(s): %', still_writable;
  END IF;

  SELECT string_agg(polname, ', ' ORDER BY polname)
    INTO leftover_policy
    FROM pg_policy
   WHERE polrelid = 'public.connections'::regclass
     AND polcmd = 'w';

  IF leftover_policy IS NOT NULL THEN
    RAISE EXCEPTION
      'connections: an UPDATE policy is still present: %', leftover_policy;
  END IF;

  -- The server side path must be untouched. If this fires, the revoke hit the
  -- wrong grantee and sync would stop writing rather than fail visibly.
  IF NOT has_table_privilege('service_role', 'public.connections', 'UPDATE') THEN
    RAISE EXCEPTION
      'connections: service_role lost UPDATE, the server side path is broken';
  END IF;

  -- The client paths this migration must not break.
  IF NOT has_table_privilege('authenticated', 'public.connections', 'INSERT') THEN
    RAISE EXCEPTION 'connections: authenticated lost INSERT, the add connection path is broken';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.connections', 'DELETE') THEN
    RAISE EXCEPTION 'connections: authenticated lost DELETE, the delete path is broken';
  END IF;
END $$;
