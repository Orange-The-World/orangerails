-- Narrow the UPDATE privilege for authenticated on public.connections down to
-- the two columns the browser client legitimately writes.
--
-- NOTE ON THE FILE NAME. It says "revoke" because the first version of this
-- migration revoked UPDATE outright. That was wrong, for the reason set out
-- under THE CORRECTION below. The name is kept because renaming an unapplied
-- migration file is not worth a second version number, but this file both
-- revokes and re-grants, and the re-grant is the point.
--
-- THE REQUIREMENT
--
-- public.connections holds server side operational values in the same row as
-- the fields the browser renders. strike_webhook_secret is one of them: it is
-- the key an inbound Strike webhook is authenticated against. It is server side
-- only: the authenticated role must hold neither read nor write on it. Both
-- halves of that are required, and the read half alone is not sufficient.
--
-- Row level security cannot express that. A policy filters ROWS, not COLUMNS,
-- so the requirement has to be enforced as a privilege.
--
-- THE CORRECTION, recorded because the reasoning matters more than the result
--
-- The first version of this file revoked UPDATE from authenticated entirely and
-- dropped the UPDATE policy with it. That rested on a claim that the browser
-- client never updates this table, reached by reading the whole of
-- src/routes/app.tsx and finding no update in it. The claim was false.
--
--   src/lib/vault-persist.ts lines 155 to 158
--     .from("connections").update(connUpdate).eq("id", conn.id)
--   where connUpdate carries encrypted_credentials (line 142, always) and
--   encrypted_label (lines 145 and 148, when the row has one).
--
--   Reached from src/routes/recover.tsx line 87, which passes the BROWSER
--   client, so it executes as role authenticated, not as service_role.
--
-- The read of app.tsx was accurate. The write is simply not in that file any
-- more: it was inline in the route component until 2026-08-31, when it was
-- lifted into the helper above. Reading the route file whole was a sufficient
-- enumeration before that commit and stopped being one after it.
--
-- What a full revoke would have cost, stated plainly: recoverWithCode() mints a
-- fresh master key and rewrites every connection row's ciphertext under it. If
-- the write back is refused, those rows stay wrapped under a key that no longer
-- exists. Silent, permanent, and triggered by the recovery path specifically,
-- which is the one path a user reaches when they are already in trouble.
--
-- THE CLIENT WRITE SURFACE, and therefore the grant
--
--   encrypted_credentials   rewritten on vault rotation and recovery
--   encrypted_label         rewritten alongside it when the row has a label
--
-- Those two, and nothing else. Every other writer to this table runs under the
-- service role key inside supabase/functions, and service_role is a separate
-- grantee that this file does not touch.
--
-- HONEST LIMIT ON THAT ENUMERATION. It is the union of two independent reads:
-- app.tsx read whole at dev head by two people, and vault-persist.ts read at dev
-- head. It is NOT a mechanical enumeration of every file under src/. This repo
-- is not in GitHub's code search index, so a code search over it returns an
-- empty list whether or not a match exists, and the local clones on the seat
-- that wrote this are 63 hours stale, which is older than the commit that moved
-- the write. If a third client side writer exists, it will fail loudly with
-- "permission denied for table connections" rather than corrupting anything,
-- and the fix is to add its column here. That is the safe direction, but it is
-- a real residual and it is why this file says so instead of claiming a
-- completeness it cannot demonstrate.
--
-- THE ORDER OF THE TWO STATEMENTS IS LOAD BEARING
--
-- A table level REVOKE clears column level grants held by the same grantee for
-- that privilege. So the REVOKE must come first and the column GRANT second.
-- Reversed, the revoke would silently wipe the grant that the line above it had
-- just made, and the self check at the bottom would be the only thing to notice.
--
-- THE POLICY STAYS
--
-- "Direct users can update connections via their subaccount" is KEPT. The
-- earlier version dropped it, which would have blocked the recovery path just as
-- effectively as removing the privilege: with the column grant present but no
-- UPDATE policy, the statement is permitted and then matches zero rows. Its
-- USING expression restricts the user to rows under their own subaccount, and
-- because it has no WITH CHECK the same expression is applied to the post image,
-- so a user cannot move a row to somebody else's subaccount either.
--
-- WHAT THIS DOES NOT TOUCH
--
-- SELECT, INSERT and DELETE and their three policies are unchanged, so the list,
-- add and delete paths keep working. Revoking one privilege at table level does
-- not disturb a column level grant of a DIFFERENT privilege, so the column level
-- SELECT work on this table is unaffected by this file whichever order the two
-- land in.
--
-- SHOWN TO WORK, AND SHOWN TO REFUSE, BEFORE BEING TRUSTED
--
-- Both statements plus the checks below were run on the dev project on
-- 2026-09-02 inside a transaction that was rolled back, then the catalogue was
-- re-read to confirm nothing was left behind:
--
--   has_table_privilege(authenticated, connections, UPDATE)  false
--   updatable columns for authenticated                      encrypted_credentials, encrypted_label
--   UPDATE policy still present                              true
--
--   as role authenticated:
--     UPDATE ... SET strike_webhook_secret  REFUSED, permission denied for table connections
--     UPDATE ... SET status                 REFUSED, permission denied for table connections
--     UPDATE ... SET encrypted_credentials, encrypted_label   ALLOWED
--     UPDATE ... SET encrypted_credentials                    ALLOWED
--
-- The two ALLOWED lines are the recovery path. They are checked because a
-- migration that only proves it blocked something has not proved it left the
-- product working.
--
-- ROLLBACK
--
--   REVOKE UPDATE ON public.connections FROM authenticated;
--   GRANT UPDATE ON public.connections TO authenticated;
--
-- That restores the table wide write, and with it the ability of a row's owner
-- to set their own webhook secret. It is written down because a rollback path
-- has to exist, not because it is a safe end state.

REVOKE UPDATE ON public.connections FROM authenticated;

GRANT UPDATE (encrypted_credentials, encrypted_label)
  ON public.connections TO authenticated;

-- Self check. This asserts the OUTCOME rather than the statements, so a column
-- added to this table later, or a grant restored by hand, is caught here instead
-- of passing silently. has_column_privilege is used rather than reading attacl,
-- because an empty attacl means "inherits the table grant", which is exactly the
-- state being removed and would read as safe.
DO $$
DECLARE
  expected_cols text := 'encrypted_credentials, encrypted_label';
  actual_cols   text;
BEGIN
  -- 1. The table wide write must be gone. has_table_privilege does not consider
  --    column grants, which was verified on dev rather than assumed: with only
  --    the two column grants in place it returned false while
  --    has_any_column_privilege returned true.
  IF has_table_privilege('authenticated', 'public.connections', 'UPDATE') THEN
    RAISE EXCEPTION
      'connections: authenticated still holds table level UPDATE';
  END IF;

  -- 2. The writable set must be EXACTLY the two client columns. An equality
  --    check, not a check that the secret is absent: a set comparison also
  --    catches a column nobody thought about, including one added years from now.
  SELECT coalesce(string_agg(a.attname, ', ' ORDER BY a.attname), 'NONE')
    INTO actual_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.connections'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('authenticated', 'public.connections', a.attname, 'UPDATE');

  IF actual_cols IS DISTINCT FROM expected_cols THEN
    RAISE EXCEPTION
      'connections: authenticated UPDATE columns are [%], expected [%]',
      actual_cols, expected_cols;
  END IF;

  -- 3. The column this ticket exists for, named explicitly. Redundant against
  --    check 2 and deliberately kept: it states the requirement in the failure
  --    message, so whoever trips it reads why rather than just what.
  IF has_column_privilege('authenticated', 'public.connections',
                          'strike_webhook_secret', 'UPDATE') THEN
    RAISE EXCEPTION
      'connections: authenticated can still write strike_webhook_secret, which is the inbound webhook key';
  END IF;

  -- 4. The recovery path needs the policy as well as the privilege. Without an
  --    UPDATE policy the grant above is permitted and then matches zero rows,
  --    which breaks rotation exactly as a missing grant would, but quietly.
  IF NOT EXISTS (
        SELECT 1 FROM pg_policy
         WHERE polrelid = 'public.connections'::regclass
           AND polcmd = 'w') THEN
    RAISE EXCEPTION
      'connections: the UPDATE policy is gone, so the vault recovery write would match zero rows';
  END IF;

  -- 5. The server side path must be untouched. If this fires, the revoke hit the
  --    wrong grantee and sync would stop writing rather than fail visibly.
  IF NOT has_table_privilege('service_role', 'public.connections', 'UPDATE') THEN
    RAISE EXCEPTION
      'connections: service_role lost UPDATE, the server side path is broken';
  END IF;

  -- 6. The client paths this migration must not break.
  IF NOT has_table_privilege('authenticated', 'public.connections', 'INSERT') THEN
    RAISE EXCEPTION 'connections: authenticated lost INSERT, the add connection path is broken';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.connections', 'DELETE') THEN
    RAISE EXCEPTION 'connections: authenticated lost DELETE, the delete path is broken';
  END IF;
END $$;
