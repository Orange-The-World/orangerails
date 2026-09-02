-- Column level SELECT grant for authenticated on public.connections.
--
-- THE REQUIREMENT
--
-- public.connections holds server side operational values alongside the
-- fields the browser renders. strike_webhook_secret is one of them: it is the
-- shared secret used to authenticate inbound Strike webhooks, so it is server
-- side only and the authenticated role must never hold SELECT on it.
--
-- Row level security cannot express that. A policy filters ROWS, not COLUMNS,
-- so the requirement has to be enforced as a privilege: a column level SELECT
-- grant naming only what the client reads, in place of a table level one.
--
-- WHAT THIS DOES
--
-- Replaces the table level SELECT grant for authenticated with a column level
-- SELECT grant naming only the columns the browser client actually reads, and
-- removes the anon SELECT grant, which no policy admits and which is
-- therefore unused.
--
-- THE COLUMN SET, AND WHY EACH ONE IS IN IT
--
-- Enumerated at dev head from the two client side readers of this table:
-- src/routes/app.tsx (the connection list) and src/lib/vault-persist.ts
-- (vault recovery, called from src/routes/recover.tsx with the browser
-- client, so it runs as authenticated). Every other reader is an edge
-- function under supabase/functions, and those hold the service role key,
-- which is a separate grantee and is untouched here.
--
-- An earlier version of this file said app.tsx was the only client side
-- reader. That was false. Commit d51ed3d85cad moved the recovery read and
-- write out of the route component into src/lib/vault-persist.ts, and that
-- helper reads encrypted_credentials back to re-wrap it under the fresh
-- master key. Leaving that column out of this grant broke vault recovery
-- for every signed in user, with a permission error at the read.
--
-- HOW COMPLETE THIS LIST IS, stated rather than assumed. Both files above
-- were read whole at dev head, and every route in the generated router
-- manifest src/routeTree.gen.ts was checked at dev head for a browser
-- client read of this table. What cannot be done from here is prove a
-- string is absent from the current tree: there is no search over live
-- code and the local clones are days behind. So this list is complete over
-- the files named here, and it is not proof that no other reader exists. A
-- new client read of a column on this table has to add that column here in
-- the same change.
--
--   id                    row key, and the filter for the two delete paths
--   subaccount_id         the WHERE filter on the list query. Postgres
--                         requires SELECT on a column used in WHERE, so this
--                         has to be granted even though the client never
--                         displays it
--   provider_type         rendered on the connection card
--   status                rendered on the connection card
--   encrypted_label       ciphertext, decrypted in the browser and rendered
--   encrypted_last_error  ciphertext, decrypted in the browser and rendered
--   last_sync_at          rendered on the connection card
--   created_at            the ORDER BY on the list query
--   encrypted_credentials ciphertext under the user's own key. Vault
--                         recovery reads every row back, re-encrypts it
--                         under the fresh master key and writes it back:
--                         src/lib/vault-persist.ts, the paged read at the
--                         top of migrateAndPersistRotatedVault. Granting
--                         SELECT on it costs nothing the requirement above
--                         cares about: the server cannot read it either
--                         way, and it is not the webhook secret
--
-- DELIBERATELY EXCLUDED
--
--   strike_webhook_secret     server side only, see the requirement above
--   credentials_key_version   written by the add connection insert. INSERT
--                             is a separate privilege from SELECT, so
--                             excluding it from SELECT does not affect the
--                             add connection path, and no client reader
--                             found at dev head reads it back
--   last_sync_cursor          declared in the client type and read nowhere
--   updated_at                no client reader
--   strike_subscription_id    no client reader
--   quiltt_connection_id      no client reader
--   account_emitted_id        no client reader
--   account_fingerprint       no client reader
--   data_key_generation       no client reader
--
-- ORDER MATTERS HERE
--
-- A table level REVOKE also clears COLUMN level grants for that grantee, so
-- the REVOKE has to come before the GRANT or the column grant is silently
-- wiped. This table has no column grants today so nothing existing is lost,
-- but the order is written this way on purpose: getting it backwards is a
-- silent failure, not an error, and it has been got backwards before.
--
-- PAIRED CLIENT CHANGE
--
-- The list query used select("*"). PostgREST passes that through as a whole
-- row expansion, which needs table level SELECT and would start failing the
-- moment this migration lands. The same pull request narrows that query to
-- the eight columns it reads. The recovery read in src/lib/vault-persist.ts
-- already names its three columns and needs no change, but it is the reason
-- encrypted_credentials is in the grant. The migration and the client
-- change have to ship together.
--
-- ROLLBACK
--
--   REVOKE SELECT (id, subaccount_id, provider_type, status, encrypted_label,
--                  encrypted_last_error, last_sync_at, created_at,
--                  encrypted_credentials)
--     ON public.connections FROM authenticated;
--   GRANT SELECT ON public.connections TO authenticated;
--   GRANT SELECT ON public.connections TO anon;
--
-- The rollback widens the grant back to table level, so it drops the
-- requirement stated at the top of this file. It is written down because a
-- rollback path has to exist, not because it is a safe end state.

REVOKE SELECT ON public.connections FROM anon;
REVOKE SELECT ON public.connections FROM authenticated;

GRANT SELECT (
  id,
  subaccount_id,
  provider_type,
  status,
  encrypted_label,
  encrypted_last_error,
  last_sync_at,
  created_at,
  encrypted_credentials
) ON public.connections TO authenticated;

-- Self check. This asserts the outcome rather than the statements, so a
-- future column added to this table is caught here instead of quietly
-- inheriting a grant. has_column_privilege is used rather than reading
-- attacl, because an empty attacl means "inherits the table grant", which is
-- exactly the state being removed and would read as safe.
DO $$
DECLARE
  granted CONSTANT text[] := ARRAY[
    'id',
    'subaccount_id',
    'provider_type',
    'status',
    'encrypted_label',
    'encrypted_last_error',
    'last_sync_at',
    'created_at',
    'encrypted_credentials'
  ];
  still_readable text;
  missing text;
BEGIN
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname)
    INTO still_readable
    FROM pg_attribute a
   WHERE a.attrelid = 'public.connections'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND NOT (a.attname = ANY (granted))
     AND has_column_privilege('authenticated', 'public.connections', a.attname, 'SELECT');

  IF still_readable IS NOT NULL THEN
    RAISE EXCEPTION
      'connections: authenticated can still SELECT column(s): %', still_readable;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c)
    INTO missing
    FROM unnest(granted) AS c
   WHERE NOT has_column_privilege('authenticated', 'public.connections', c, 'SELECT');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'connections: authenticated lost SELECT on column(s) the client needs: %', missing;
  END IF;

  IF has_table_privilege('anon', 'public.connections', 'SELECT') THEN
    RAISE EXCEPTION 'connections: anon can still SELECT';
  END IF;
END $$;

COMMENT ON COLUMN public.connections.strike_webhook_secret IS
  'Strike webhook signing secret. Server side only: it is how we prove an inbound webhook came from Strike, so the owning user must never be able to read it. Not in the authenticated column level SELECT grant, and must not be added to it.';
