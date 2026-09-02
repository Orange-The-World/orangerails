-- ============================================================
-- Say in the schema what is actually true of four credential
-- columns on public.platforms and public.apps.
--
-- OR-T1568, implementing part (b) of the ruling recorded on
-- OR-T1527, under parent OR-T1433. The accepted risk these
-- comments point at is recorded as the agent_resources row
-- named or-accepted-risk-plaintext-platform-credentials.
--
-- WHY THIS EXISTS
-- Three of these columns hold third party credentials in
-- plaintext by an accepted decision. The only thing protecting
-- them is that the grants on platforms and apps are column
-- scoped and none of the secret columns is in the granted list.
-- One table wide GRANT on either table re-exposes every one of
-- them at once. The audience most likely to be fooled is a
-- person or a check inspecting the schema, and a column comment
-- is where that audience looks.
--
-- WHY THIS IS A CORRECTION AND NOT AN ADDITION
-- The fourth column, platforms.quiltt_api_key_ciphertext, today
-- carries a comment reading "Encrypted at rest". Measured on
-- 2026-09-02 against both the dev project and the production
-- project: the column is empty (0 of 8 rows populated on
-- production), nothing reads or writes it, and no encryption
-- path for platform credentials exists anywhere. So the schema
-- currently tells a reader that a credential is encrypted at
-- rest when neither the credential nor the encryption exists.
-- That is the exact misreading this step was asked to end.
--
-- ORDER INDEPENDENT ON PURPOSE
-- A separate change removes platforms.quiltt_api_key_ciphertext
-- entirely. Rather than coupling the two files by timestamp,
-- which would make each of them correct only in one order, every
-- statement here is guarded on its column still existing. This
-- file is therefore correct whether it applies before that drop,
-- after it, or if that drop never lands.
--
-- WHAT THIS DOES NOT DO, AND WHY
-- It contains no grant assertion. A DO block inside a migration
-- runs once, at apply time, and never again, so it cannot be the
-- standing check that the accepted risk is conditional on. That
-- check has to run on every CI run and is tracked as its own
-- piece of work. Putting one here would look like the control
-- exists while doing none of the watching.
--
-- REVERSIBLE
-- This writes catalog comments only. No data, no grant, no
-- policy, no column, no privilege changes.
--
-- ROLLBACK (commented on purpose, run by hand only, with intent)
--   COMMENT ON COLUMN public.platforms.webhook_secret IS NULL;
--   COMMENT ON COLUMN public.platforms.quiltt_api_key IS NULL;
--   COMMENT ON COLUMN public.apps.client_secret IS NULL;
--   COMMENT ON COLUMN public.platforms.quiltt_api_key_ciphertext IS NULL;
-- Note that this rollback CLEARS the comments rather than
-- restoring the previous text. The previous text on the
-- ciphertext column asserted an encryption that has never
-- existed, so restoring it is not a state anyone should be able
-- to reach by accident.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.platforms') IS NULL THEN
    RAISE EXCEPTION 'public.platforms does not exist here. This migration is aimed at the wrong database.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'platforms'
       AND column_name  = 'webhook_secret'
  ) THEN
    EXECUTE $c$
      COMMENT ON COLUMN public.platforms.webhook_secret IS
        'HMAC-SHA256 signing secret for outbound webhooks to this platform. PLAINTEXT: it is not encrypted at rest, by an accepted decision recorded as or-accepted-risk-plaintext-platform-credentials (raised on OR-T1433, ruled on OR-T1527). The protection is the column level grant, nothing else: anon and authenticated hold no privilege on this column and none may ever be granted. A table wide GRANT on public.platforms re-exposes this and every other secret column here at once, so this column must never be added to one. Reachable by service_role only.'
    $c$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'platforms'
       AND column_name  = 'quiltt_api_key'
  ) THEN
    EXECUTE $c$
      COMMENT ON COLUMN public.platforms.quiltt_api_key IS
        'Quiltt vendor API key, and the LIVE read path for it. PLAINTEXT: it is not encrypted at rest, by an accepted decision recorded as or-accepted-risk-plaintext-platform-credentials (raised on OR-T1433, ruled on OR-T1527). The protection is the column level grant, nothing else: anon and authenticated hold no privilege on this column and none may ever be granted. A table wide GRANT on public.platforms re-exposes this and every other secret column here at once, so this column must never be added to one. Reachable by service_role only.'
    $c$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'platforms'
       AND column_name  = 'quiltt_api_key_ciphertext'
  ) THEN
    EXECUTE $c$
      COMMENT ON COLUMN public.platforms.quiltt_api_key_ciphertext IS
        'EMPTY, UNUSED, NOT THE LIVE READ PATH, AND PENDING REMOVAL. Measured 2026-09-02 on both the dev and the production project: zero rows populated, and no code path reads or writes it. The live read path for a Quiltt key is public.platforms.quiltt_api_key, which is PLAINTEXT. This column previously carried a comment saying it was encrypted at rest. That was never true of any stored value, because no value was ever stored and no encryption path for platform credentials exists. Do not populate it and do not build on it: removal is tracked as OR-T1476. Per platform credential encryption is a key management design that does not exist yet, and half building it here would put real secrets in a column nothing decrypts.'
    $c$;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.apps') IS NULL THEN
    RAISE EXCEPTION 'public.apps does not exist here. This migration is aimed at the wrong database.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'apps'
       AND column_name  = 'client_secret'
  ) THEN
    EXECUTE $c$
      COMMENT ON COLUMN public.apps.client_secret IS
        'HMAC-SHA256 signing secret for the app. PLAINTEXT: it is not encrypted at rest, by an accepted decision recorded as or-accepted-risk-plaintext-platform-credentials (raised on OR-T1433, ruled on OR-T1527). The protection is the column level grant, nothing else: anon and authenticated hold no privilege on this column and none may ever be granted. A table wide GRANT on public.apps re-exposes it, so this column must never be added to one. Reachable by service_role only.'
    $c$;
  END IF;
END
$$;

-- ============================================================
-- Assertions: this migration proves its own end state or it fails.
--
-- Each check is guarded on the column existing, for the same
-- order independence reason as the statements above. A column
-- that is not here is skipped and is not an error; a column that
-- IS here and did not get its comment is an error, because that
-- is the case where this file silently did nothing.
-- ============================================================

DO $$
DECLARE
  target   RECORD;
  body     TEXT;
  checked  INT := 0;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('platforms', 'webhook_secret'),
      ('platforms', 'quiltt_api_key'),
      ('platforms', 'quiltt_api_key_ciphertext'),
      ('apps',      'client_secret')
    ) AS t(tbl, col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = target.tbl
         AND column_name  = target.col
    ) THEN
      CONTINUE;
    END IF;

    SELECT d.description INTO body
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = target.col
      LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum
     WHERE n.nspname = 'public' AND c.relname = target.tbl;

    IF body IS NULL OR body = '' THEN
      RAISE EXCEPTION 'public.%.% still has no comment after this migration ran', target.tbl, target.col;
    END IF;

    IF position('or-accepted-risk-plaintext-platform-credentials' IN body) = 0
       AND position('PENDING REMOVAL' IN body) = 0
    THEN
      RAISE EXCEPTION 'public.%.% carries a comment this migration did not write: %', target.tbl, target.col, left(body, 80);
    END IF;

    -- The specific lie this file exists to remove. If any of these
    -- four columns still claims encryption at rest, the correction
    -- did not take and a schema level reader is still being told
    -- something untrue.
    IF position('ncrypted at rest' IN body) > 0 THEN
      RAISE EXCEPTION 'public.%.% still claims encryption at rest', target.tbl, target.col;
    END IF;

    checked := checked + 1;
  END LOOP;

  -- Count, not just absence of failure. Three of the four columns
  -- are unconditional on every database this runs against, so a
  -- run that verified fewer than three checked almost nothing and
  -- must not be read as a pass.
  IF checked < 3 THEN
    RAISE EXCEPTION 'only % of the 4 target columns were present and verified. Expected at least 3. This migration checked almost nothing and must not report success.', checked;
  END IF;

  RAISE NOTICE 'platform credential column comments: % of 4 columns present and verified', checked;
END
$$;
