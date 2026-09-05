-- Column level INSERT grant for authenticated on public.connections.
--
-- THE REQUIREMENT
--
-- public.connections holds server side operational values in the same row as
-- the fields the browser renders. strike_webhook_secret is one of them: it is
-- the key an inbound Strike webhook is authenticated against. It is server side
-- only, so the authenticated role must hold neither read nor write on it.
--
-- "Write" is not one privilege. On a row it is two: the ability to change the
-- column on a row that already exists (UPDATE) and the ability to choose its
-- value on a row being created (INSERT). Closing one and leaving the other is
-- not closing the requirement.
--
-- WHERE THIS SITS IN THE SERIES, so a reader of any one file is not misled
--
--   20260902040000  read half.      Table SELECT replaced by a column level
--                                   SELECT grant. strike_webhook_secret is not
--                                   in it.
--   20260902230000  overwrite half. Table UPDATE narrowed to
--                                   encrypted_credentials and encrypted_label.
--   this file        create half.   Table INSERT narrowed to the six columns
--                                   the add connection path names.
--
-- Each of those three files states the requirement in full and delivers one
-- part of it. That is the honest reading of all three: the requirement is met
-- across the set, not by any single one of them.
--
-- WHY THIS FILE SORTS AFTER 20260902230000, and it is load bearing
--
-- That file's self check asserts that the authenticated role still holds table
-- level INSERT, which was true when it was written and stops being true the
-- moment this file runs. Applied in timestamp order on a fresh database the two
-- are consistent: it runs first, passes, and this file then narrows what it
-- checked. Reversed, that check would fail on replay. The timestamp is what
-- enforces the order, so do not renumber this file below it.
--
-- WHAT THIS DOES
--
-- Replaces the table level INSERT grant for authenticated with a column level
-- INSERT grant naming only the columns the browser client supplies when it
-- creates a connection.
--
-- THE COLUMN SET, AND WHY EACH ONE IS IN IT
--
-- Read off the one browser client insert into this table, src/routes/app.tsx,
-- handleAddConnection, at dev head. It names these six and nothing else:
--
--   subaccount_id            the owning subaccount, also the column the INSERT
--                            policy checks
--   provider_type            the connector the user picked
--   encrypted_label          ciphertext, encrypted in the browser
--   encrypted_credentials    ciphertext, encrypted in the browser
--   credentials_key_version  which key version wrapped the credentials
--   status                   set to active on create
--
-- The remaining columns are either server written or defaulted. id,
-- created_at, updated_at, status and credentials_key_version all carry
-- defaults, and a default is applied without any privilege on the column, so
-- leaving a column out of this grant does not stop a row being created. The
-- three columns with no default and NOT NULL are provider_type,
-- encrypted_credentials and subaccount_id, and all three are in the set above,
-- so a valid row is still constructible from the client.
--
-- DELIBERATELY EXCLUDED, and the one that matters
--
--   strike_webhook_secret    server side only, see the requirement above. This
--                            is the column this file exists for.
--   account_fingerprint      server computed, written by the hosted link path
--   account_emitted_id       server computed, written by the hosted link path
--   strike_subscription_id   server written
--   quiltt_connection_id     server written
--   last_sync_at             server written
--   last_sync_cursor         server written
--   encrypted_last_error     server written
--   data_key_generation      defaulted, server owned
--
-- THE SERVER SIDE PATH IS UNTOUCHED, and it was checked rather than assumed
--
-- supabase/functions/or-link-complete/index.ts also inserts into this table,
-- and it names eight columns, including account_fingerprint and
-- account_emitted_id which are NOT in the grant above. That path was read at
-- dev head: every statement in it goes through the service role client, and
-- service_role is a separate grantee holding table level INSERT, which this
-- file does not touch. Narrowing the authenticated grant therefore cannot
-- reach it. The self check below asserts that explicitly, because if the
-- revoke ever hit the wrong grantee the hosted link flow would stop creating
-- connections and nothing else would say so.
--
-- HONEST LIMIT ON THE ENUMERATION. The client insert list is the union of two
-- independent whole file reads of src/routes/app.tsx at dev head, on the same
-- day, both finding one insert and the same six columns, plus a whole file
-- read of src/lib/vault-persist.ts at dev head, which updates this table and
-- does not insert into it. It is NOT a mechanical enumeration of every file
-- under src/. This repository is not in the GitHub code search index, so a
-- code search over it returns an empty list whether or not a match exists, and
-- the local clone available to the author is 186 hours stale, which is older
-- than the commit that created vault-persist.ts. If a third client side insert
-- exists it will fail loudly with "permission denied for table connections"
-- rather than corrupting anything, and the fix is to add its column here. That
-- is the safe direction, and it is a real residual rather than a completeness
-- claim.
--
-- THE ORDER OF THE TWO STATEMENTS IS LOAD BEARING
--
-- A table level REVOKE clears column level grants held by the same grantee for
-- that privilege, so the REVOKE must come first and the column GRANT second.
-- Reversed, the revoke silently wipes the grant the line above it just made.
-- Revoking one privilege at table level does not disturb a column level grant
-- of a DIFFERENT privilege, so the column level SELECT and UPDATE work on this
-- table is unaffected by this file whichever order those land in.
--
-- SHOWN TO WORK, AND SHOWN TO REFUSE, BEFORE BEING TRUSTED
--
-- Run on the dev project on 2026-09-02 inside a block that rolled itself back,
-- then the catalogue was re-read to confirm nothing was left behind.
--
--   after the two statements:
--     has_table_privilege(authenticated, connections, INSERT)   false
--     insertable columns for authenticated                      the six above
--     strike_webhook_secret insertable                          false
--     has_table_privilege(service_role, connections, INSERT)    true
--
--   as role authenticated:
--     INSERT naming strike_webhook_secret
--       42501 permission denied for table connections
--     INSERT naming the six client columns
--       42501 new row violates row level security policy for table "connections"
--
--   Those two lines are the whole proof and they say different things. The
--   first is the privilege refusing the column. The second is the privilege
--   PASSING and row level security then doing its own job, because the probe
--   ran with no signed in user: the add connection path keeps the privilege it
--   needs. A migration that only proves it blocked something has not proved it
--   left the product working.
--
--   The self check below was then shown to FAIL, on purpose, by granting
--   INSERT on strike_webhook_secret back and running it:
--     check 2  connections: authenticated INSERT columns are [... , strike_webhook_secret, ...],
--              expected [credentials_key_version, encrypted_credentials,
--              encrypted_label, provider_type, status, subaccount_id]
--     check 3  connections: authenticated can still set strike_webhook_secret
--              on a row it creates, which is the inbound webhook key
--   Both raised. A check nobody has watched go red is not a check.
--
--   Check 4 was amended after review on 2026-09-02 and its amended form was
--   put through the same treatment. It was shown to RAISE by pointing the
--   same predicate at a live table whose only policy is permissive FOR ALL to
--   service_role:
--     connections: no permissive INSERT (or FOR ALL) policy applies to
--     authenticated, so the add connection path is refused by row level
--     security
--   and shown to PASS against this table's live policy set, which is four
--   permissive policies to authenticated, one per command.
--
-- BEFORE THIS IS APPLIED TO PRODUCTION
--
-- The measurements above are from the dev project. The production catalogue is
-- not readable from the seat that wrote this file, so run the same read there
-- first and confirm the starting state matches:
--
--   SELECT a.grantee::regrole::text, a.privilege_type
--     FROM pg_class c, aclexplode(c.relacl) a
--    WHERE c.oid = 'public.connections'::regclass;
--
-- If production carries a client insert path that names a column outside the
-- six, this file refuses at the self check and the apply fails loudly, which is
-- the safe direction but is still worth knowing before the window opens.
--
-- ROLLBACK
--
--   REVOKE INSERT (subaccount_id, provider_type, encrypted_label,
--                  encrypted_credentials, credentials_key_version, status)
--     ON public.connections FROM authenticated;
--   GRANT INSERT ON public.connections TO authenticated;
--
-- That restores the table wide insert, and with it the ability of a row's
-- creator to choose their own webhook secret. It is written down because a
-- rollback path has to exist, not because it is a safe end state.

REVOKE INSERT ON public.connections FROM authenticated;

GRANT INSERT (
  subaccount_id,
  provider_type,
  encrypted_label,
  encrypted_credentials,
  credentials_key_version,
  status
) ON public.connections TO authenticated;

-- Self check. This asserts the OUTCOME rather than the statements, so a column
-- added to this table later, or a grant restored by hand, is caught here
-- instead of passing silently. has_column_privilege is used rather than
-- reading attacl, because an empty attacl means "inherits the table grant",
-- which is exactly the state being removed and would read as safe.
DO $$
DECLARE
  expected_cols CONSTANT text :=
    'credentials_key_version, encrypted_credentials, encrypted_label, provider_type, status, subaccount_id';
  actual_cols text;
BEGIN
  -- 1. The table wide insert must be gone. has_table_privilege does not
  --    consider column grants, which was verified on dev rather than assumed.
  IF has_table_privilege('authenticated', 'public.connections', 'INSERT') THEN
    RAISE EXCEPTION
      'connections: authenticated still holds table level INSERT';
  END IF;

  -- 2. The insertable set must be EXACTLY the six client columns. An equality
  --    check, not a check that the secret is absent: a set comparison also
  --    catches a column nobody thought about, including one added years from
  --    now. Ordered alphabetically because string_agg needs a deterministic
  --    order to compare against a literal.
  SELECT coalesce(string_agg(a.attname, ', ' ORDER BY a.attname), 'NONE')
    INTO actual_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.connections'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('authenticated', 'public.connections', a.attname, 'INSERT');

  IF actual_cols IS DISTINCT FROM expected_cols THEN
    RAISE EXCEPTION
      'connections: authenticated INSERT columns are [%], expected [%]',
      actual_cols, expected_cols;
  END IF;

  -- 3. The column this change exists for, named explicitly. Redundant against
  --    check 2 and deliberately kept: it states the requirement in the failure
  --    message, so whoever trips it reads why rather than just what.
  IF has_column_privilege('authenticated', 'public.connections',
                          'strike_webhook_secret', 'INSERT') THEN
    RAISE EXCEPTION
      'connections: authenticated can still set strike_webhook_secret on a row it creates, which is the inbound webhook key';
  END IF;

  -- 4. The add connection path needs the policy as well as the privilege.
  --    Without an applicable INSERT policy the grant above is permitted and the
  --    statement is then refused by row level security, which breaks adding a
  --    connection exactly as a missing grant would.
  --
  --    THREE THINGS THIS PREDICATE HAS TO GET RIGHT. A test for "a policy with
  --    polcmd = 'a' exists" answers a different question from "an insert by
  --    this role is admitted", and the gap runs in both directions:
  --
  --      polcmd IN ('a','*')  a FOR ALL policy covers INSERT. Testing 'a'
  --                           alone raises on a table whose insert is in fact
  --                           covered, which blocks a legitimate apply.
  --      polpermissive        a RESTRICTIVE policy grants nothing, it only
  --                           narrows. With no applicable PERMISSIVE policy the
  --                           insert is still refused, so a restrictive only
  --                           policy must not satisfy this check.
  --      role MEMBERSHIP      row level security applies a policy when the
  --                           current role is a MEMBER of one of polroles, not
  --                           only when it is named. An exact oid match reads
  --                           false for a policy addressed to a group role that
  --                           authenticated belongs to, which is a false fail.
  --
  --    r = 0 is the PUBLIC case and must stay. pg_has_role returns false for
  --    oid 0 rather than raising (measured on dev, not assumed), so without
  --    that branch a policy written TO public would read as not applying.
  IF NOT EXISTS (
        SELECT 1 FROM pg_policy p
         WHERE p.polrelid = 'public.connections'::regclass
           AND p.polcmd IN ('a', '*')
           AND p.polpermissive
           AND EXISTS (SELECT 1 FROM unnest(p.polroles) r
                        WHERE r = 0 OR pg_has_role('authenticated', r, 'MEMBER'))) THEN
    RAISE EXCEPTION
      'connections: no permissive INSERT (or FOR ALL) policy applies to authenticated, so the add connection path is refused by row level security';
  END IF;

  -- 5. The client reads the new row's id straight back through the RETURNING
  --    clause of the same statement, so SELECT on id has to survive. This is
  --    true whether id is readable through a table grant or a column grant,
  --    which is why it is checked with has_column_privilege and not by looking
  --    for a particular shape of grant.
  IF NOT has_column_privilege('authenticated', 'public.connections', 'id', 'SELECT') THEN
    RAISE EXCEPTION
      'connections: authenticated cannot read id back, so the add connection path cannot return the new row';
  END IF;

  -- 6. The server side path must be untouched. If this fires, the revoke hit
  --    the wrong grantee and the hosted link flow would stop creating
  --    connections rather than fail visibly.
  IF NOT has_table_privilege('service_role', 'public.connections', 'INSERT') THEN
    RAISE EXCEPTION
      'connections: service_role lost INSERT, the hosted link path is broken';
  END IF;
END $$;
