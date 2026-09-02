-- Step 1 of the plaintext third party credential decision (OR-T1433, ruled on
-- OR-T1527, executed under OR-T1568).
--
-- WHAT THIS FILE DOES, and it deliberately changes no privilege and no data:
--   1. COMMENT ON COLUMN on all four columns named in the ruling.
--   2. An assertion block that FAILS THE APPLY if the grant boundary protecting
--      the three populated plaintext columns has been widened.
--
-- WHY IT EXISTS. The CTO's ruling on OR-T1527 accepted three plaintext credential
-- columns as a written risk, and made that acceptance CONDITIONAL on this assertion
-- existing: "no assertion, no acceptance". The protection for these columns is not
-- encryption, it is the absence of a table wide GRANT. Nothing was watching that
-- boundary, so this file is the control the acceptance rests on.
--
-- ROLLBACK. This file grants nothing and revokes nothing. To reverse it, reset the
-- four comments to null and drop the assertion block:
--   COMMENT ON COLUMN public.platforms.webhook_secret IS NULL;
--   COMMENT ON COLUMN public.apps.client_secret IS NULL;
--   COMMENT ON COLUMN public.connections.strike_webhook_secret IS NULL;
--   COMMENT ON COLUMN public.platforms.quiltt_api_key_ciphertext IS NULL;
-- There is no data change to undo.
--
-- MEASURED BEFORE WRITING, by the DBA on 2026-09-02, on both clusters:
--   PROD lcdicqalreskibdfxkzb: platforms 8 rows / 4 populated webhook_secret;
--     apps 1 row / 1 populated client_secret; connections 45 rows / 2 populated
--     strike_webhook_secret; quiltt_api_key_ciphertext present and populated in 0 rows.
--   DEV fzwmnzmtqidumdqjdddz: platforms 9 rows / 0 populated webhook_secret;
--     apps 1 row / 1 populated client_secret; connections 4 rows / 0 populated
--     strike_webhook_secret; quiltt_api_key_ciphertext present and populated in 0 rows.
--   Neither platforms nor apps carries any table level grant to anon or authenticated
--     on either cluster, and no column level grant on any of the four columns exists to
--     anon or authenticated on either cluster.
--
-- THE ONE DIFFERENCE BETWEEN THE CLUSTERS, and it is why part of this file warns
-- instead of raising. On PROD, public.connections still carries a TABLE WIDE SELECT to
-- both anon and authenticated. On DEV it does not, because the OR-T1445 fix (PR #1097)
-- narrowed it to a column level grant and that migration has not promoted to prod yet.
-- So on prod today an authenticated caller admitted by the row policy can read
-- strike_webhook_secret. anon cannot read anything: RLS is enabled on connections and
-- all four policies are addressed to authenticated, so no policy admits anon and every
-- row is denied to it.
-- Asserting that grant away here would abort the prod deploy on a condition this file
-- is not responsible for and cannot fix. It is therefore a WARNING that names the
-- pending migration, and it is tracked to become an EXCEPTION once that migration
-- promotes.


-- ---------------------------------------------------------------------------
-- 1. THE COMMENTS
-- ---------------------------------------------------------------------------
-- Three plaintext columns: say what they are, that they are plaintext by an accepted
-- decision, what the protection actually is, and the rule that must not be broken.

COMMENT ON COLUMN public.platforms.webhook_secret IS
  'HMAC-SHA256 signing secret for outbound webhooks to this platform. PLAINTEXT BY AN '
  'ACCEPTED DECISION (OR-T1433, ruled on OR-T1527), not an oversight. The protection is '
  'the column level grant: anon and authenticated hold NO privilege on this column, and '
  'none may be granted. It must never be added to a table wide GRANT. Reachable by '
  'service_role only. A migration asserts this boundary and will fail the apply if it is '
  'widened.';

COMMENT ON COLUMN public.apps.client_secret IS
  'OAuth client secret for the app. PLAINTEXT BY AN ACCEPTED DECISION (OR-T1433, ruled '
  'on OR-T1527), not an oversight. The protection is the column level grant: anon and '
  'authenticated hold NO privilege on this column, and none may be granted. It must '
  'never be added to a table wide GRANT. Reachable by service_role only. A migration '
  'asserts this boundary and will fail the apply if it is widened.';

COMMENT ON COLUMN public.connections.strike_webhook_secret IS
  'Strike webhook signing secret. It is how we prove an inbound webhook came from Strike, '
  'so the owning user must never be able to read it. PLAINTEXT BY AN ACCEPTED DECISION '
  '(OR-T1433, ruled on OR-T1527). The protection is the column level grant: this column '
  'is not in the authenticated column level SELECT grant and must not be added to it, and '
  'the table must not carry a table wide SELECT. See OR-T1445 and OR-T1467.';


-- The fourth column is the empty ciphertext twin. Its existing comment claims the key is
-- "Encrypted at rest", which is the exact false signal the ruling set out to kill: the
-- live read path is the PLAINTEXT column, and nothing reads this one.
--
-- GUARDED, DELIBERATELY. OR-T1476 (PR #1102) drops this column. Whichever of the two
-- lands first, this file must still apply cleanly, so the comment is only set if the
-- column is still there. An unguarded COMMENT ON COLUMN would raise 42703 after the drop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'platforms'
       AND a.attname = 'quiltt_api_key_ciphertext'
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    COMMENT ON COLUMN public.platforms.quiltt_api_key_ciphertext IS
      'DEAD COLUMN, PENDING REMOVAL (OR-T1476). It is EMPTY on every cluster measured and '
      'nothing reads it. It is NOT the live read path: the live path reads the plaintext '
      'column platforms.quiltt_api_key. Do not populate it, and do not treat its presence '
      'as evidence that the Quiltt key is encrypted at rest, because it is not.';
  END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- 2. THE ASSERTION
-- ---------------------------------------------------------------------------
-- This is the control the written acceptance depends on. It fails the apply if the
-- boundary protecting the three plaintext credential columns has been widened.
--
-- It checks two distinct things, because a secret column can be exposed two ways:
--   (a) a TABLE WIDE grant on the owning table, which reaches every column including
--       the secret one, and
--   (b) a COLUMN LEVEL grant naming the secret column directly.
-- Checking only one of these is the trap: a table wide GRANT does not appear in
-- pg_attribute.attacl, and a column level GRANT does not appear in pg_class.relacl.
DO $$
DECLARE
  bad_table_grants text;
  bad_column_grants text;
  connections_wide text;
BEGIN
  -- (a) Table wide grants to anon or authenticated on platforms and apps.
  -- connections is handled separately below because prod is knowingly mid promotion.
  SELECT string_agg(
           format('%s -> %s %s', c.relname, x.grantee::regrole::text, x.privilege_type),
           ', ' ORDER BY c.relname, x.grantee::regrole::text, x.privilege_type)
    INTO bad_table_grants
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE n.nspname = 'public'
     AND c.relname IN ('platforms', 'apps')
     AND x.grantee::regrole::text IN ('anon', 'authenticated');

  IF bad_table_grants IS NOT NULL THEN
    RAISE EXCEPTION
      'Plaintext credential boundary breached: public.platforms and public.apps must carry '
      'NO table level grant to anon or authenticated, because a table wide grant reaches '
      'the plaintext secret columns (platforms.webhook_secret, apps.client_secret). Found: %. '
      'See OR-T1433 and the ruling on OR-T1527. If this grant is intended, the accepted risk '
      'must be re-decided first, not asserted around.',
      bad_table_grants;
  END IF;

  -- (b) Column level grants naming any of the secret columns.
  SELECT string_agg(
           format('%s.%s -> %s %s', c.relname, a.attname, x.grantee::regrole::text, x.privilege_type),
           ', ' ORDER BY c.relname, a.attname, x.grantee::regrole::text, x.privilege_type)
    INTO bad_column_grants
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) AS x
   WHERE n.nspname = 'public'
     AND (   (c.relname = 'platforms'   AND a.attname IN ('webhook_secret', 'quiltt_api_key_ciphertext'))
          OR (c.relname = 'apps'        AND a.attname = 'client_secret')
          OR (c.relname = 'connections' AND a.attname = 'strike_webhook_secret'))
     AND x.grantee::regrole::text IN ('anon', 'authenticated');

  IF bad_column_grants IS NOT NULL THEN
    RAISE EXCEPTION
      'Plaintext credential boundary breached: no column level grant to anon or '
      'authenticated may name a plaintext credential column. Found: %. See OR-T1433 and '
      'the ruling on OR-T1527.',
      bad_column_grants;
  END IF;

  -- (c) connections: WARNING, not EXCEPTION, and only until the OR-T1445 fix promotes.
  -- On dev this is already clean and this block is silent. On prod the table wide SELECT
  -- is still present and the fix (PR #1097) is queued behind the prod migration backlog,
  -- so raising here would abort the prod deploy over a condition this file did not create.
  SELECT string_agg(x.grantee::regrole::text, ', ' ORDER BY x.grantee::regrole::text)
    INTO connections_wide
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE n.nspname = 'public'
     AND c.relname = 'connections'
     AND x.privilege_type = 'SELECT'
     AND x.grantee::regrole::text IN ('anon', 'authenticated');

  IF connections_wide IS NOT NULL THEN
    RAISE WARNING
      'public.connections still carries a table wide SELECT to: %. That reaches the '
      'plaintext strike_webhook_secret column. This is the KNOWN pending state fixed by '
      'the OR-T1445 migration (PR #1097), which is on dev and not yet promoted to prod. '
      'Note anon is denied every row by RLS because all four policies on this table are '
      'addressed to authenticated, so the reachable case is an authenticated owner. '
      'Once that migration promotes, this WARNING must be converted to a RAISE EXCEPTION.',
      connections_wide;
  END IF;
END
$$;
