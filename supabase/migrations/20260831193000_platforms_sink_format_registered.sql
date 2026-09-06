-- Constrain public.platforms.sink_format to the slugs a sink adapter implements.
--
-- THE RULE THIS ENFORCES
--   platforms.sink_format may only hold a slug that is registered in
--   supabase/functions/_shared/sinks/dispatch.ts. A sink value and its
--   registered adapter ship together or neither ships.
--
-- THE REGISTERED SET, read at ref dev on 2026-08-31 from
-- supabase/functions/_shared/sinks/dispatch.ts, SINK_ADAPTERS:
--   bitbooks-v2    (bitbooks-v2.ts line 102, format: 'bitbooks-v2')
--   orangeway-me   (orangeway-me.ts line 167, format: 'orangeway-me')
-- Two entries in that map are commented out and therefore NOT registered:
-- bitbooksV3Sink and orangewayBooksSink. getSinkAdapter() returns null for
-- anything outside the map and or-sync surfaces that as a 400.
--
-- NULL STAYS LEGAL, ON PURPOSE
--   Whether a platform that has no sink at all expresses that as NULL or as
--   an explicit value is not settled yet. This file does not pre-empt it.
--   The nullability of the column is a separate change and must land after
--   that ruling, not before.
--
-- ORDER MATTERS
--   Step 1 clears any value with no registered adapter, step 2 constrains.
--   Not the other way round: migration 20260610150000 backfills the value
--   'orangeway-books' for the matching slug, and that adapter is commented
--   out, so on a cluster rebuilt from this tree the constraint would be
--   refused by data this tree itself created. Clearing to NULL is the only
--   state that satisfies the rule without inventing an adapter.
--
-- IDEMPOTENT
--   Re-running is a no-op: step 1 matches nothing once cleared, and step 2
--   is guarded on pg_constraint.
--
-- REVERSIBLE
--   ALTER TABLE public.platforms DROP CONSTRAINT platforms_sink_format_registered;
--   The step 1 clear is NOT reversible by that drop. The values it clears are
--   recorded by the RAISE NOTICE below and must be read out of the apply log
--   if they are ever wanted back. On the clusters measured on 2026-08-31 the
--   only value it clears is 'orangeway-books', on one row, on hosted dev and
--   on the self-hosted cluster. Production has no such row and step 1 clears
--   nothing there.
--
-- LOCKING
--   ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on public.platforms and
--   validates every row. The table holds fewer than ten rows on every cluster
--   measured, so the hold is momentary. If that ever stops being true, split
--   into ADD ... NOT VALID plus VALIDATE CONSTRAINT.

-- Step 1. Clear any stored value that no adapter implements.
DO $clear$
DECLARE
  v_bad text;
  v_n   integer;
BEGIN
  SELECT string_agg(DISTINCT sink_format, ', '), count(*)
    INTO v_bad, v_n
    FROM public.platforms
   WHERE sink_format IS NOT NULL
     AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me');

  IF v_n > 0 THEN
    RAISE NOTICE 'sink_format: clearing % row(s) holding unregistered value(s): %', v_n, v_bad;
    UPDATE public.platforms
       SET sink_format = NULL
     WHERE sink_format IS NOT NULL
       AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me');
  ELSE
    RAISE NOTICE 'sink_format: no unregistered values stored, nothing cleared';
  END IF;
END
$clear$;

-- Step 2. Constrain the value domain.
DO $constrain$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.platforms'::regclass
       AND conname  = 'platforms_sink_format_registered'
  ) THEN
    ALTER TABLE public.platforms
      ADD CONSTRAINT platforms_sink_format_registered
      CHECK (sink_format IS NULL OR sink_format IN ('bitbooks-v2', 'orangeway-me'));
  END IF;
END
$constrain$;

COMMENT ON CONSTRAINT platforms_sink_format_registered ON public.platforms IS
  'sink_format may only hold a slug registered in _shared/sinks/dispatch.ts. '
  'Adding an adapter means adding its slug here in the same change. NULL stays '
  'legal until the no-sink representation is settled.';

-- Step 3. Prove the constraint is present, VALIDATED, admits EXACTLY the
-- registered set, and actually refuses a value outside it. This block is
-- written to be able to FAIL: each check names what it found, so a run that
-- checked nothing cannot read as green.
--
-- WHY THE ADMITTED SET IS COMPARED AND NOT SUBSTRING-MATCHED. A test of the
-- shape "does the definition contain 'bitbooks-v2'" answers whether a value is
-- present, never what the whole set IS, so a constraint that also admitted a
-- third unregistered value would pass every such test. Comparing the extracted
-- set for equality fails on a superset exactly as loudly as on a subset.
--
-- WHY EXTRACTION AND NOT AN EXACT STRING COMPARE ON THE WHOLE DEFINITION. That
-- text is rendered by the server, not written by us: IN becomes = ANY (ARRAY
-- [...]) with ::text casts and its own parenthesisation. Pinning that spelling
-- would turn a formatting difference between server versions into a failed
-- apply, which gates check-pending-migrations, which gates deploy.
DO $assert$
DECLARE
  v_def       text;
  v_validated boolean;
  v_residual  integer;
  v_admitted  text[];
  v_expected  text[] := ARRAY['bitbooks-v2', 'orangeway-me'];
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated
    INTO v_def, v_validated
    FROM pg_constraint
   WHERE conrelid = 'public.platforms'::regclass
     AND conname  = 'platforms_sink_format_registered';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'assert failed: constraint platforms_sink_format_registered is absent';
  END IF;

  IF NOT v_validated THEN
    RAISE EXCEPTION 'assert failed: constraint platforms_sink_format_registered exists but is NOT VALID, so existing rows were never checked';
  END IF;

  IF v_def NOT LIKE '%sink_format%' THEN
    RAISE EXCEPTION 'assert failed: constraint does not mention sink_format at all, definition is: %', v_def;
  END IF;

  -- Every quoted literal in the rendered definition IS the admitted set. The
  -- ::text casts and the ARRAY[] wrapper carry no quotes and so contribute
  -- nothing here.
  SELECT array_agg(DISTINCT g[1] ORDER BY g[1])
    INTO v_admitted
    FROM regexp_matches(v_def, '''([^'']*)''', 'g') AS t(g);

  IF v_admitted IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'assert failed: constraint admits exactly %, expected exactly %. Full definition: %',
      coalesce(v_admitted::text, '{}'), v_expected::text, v_def;
  END IF;

  SELECT count(*) INTO v_residual
    FROM public.platforms
   WHERE sink_format IS NOT NULL
     AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me');

  IF v_residual <> 0 THEN
    RAISE EXCEPTION 'assert failed: % row(s) still hold an unregistered sink_format after step 1', v_residual;
  END IF;

  RAISE NOTICE 'sink_format value domain ok: constraint present and validated, admits exactly %, 0 residual unregistered rows', v_admitted;
END
$assert$;

-- Step 4. Prove the constraint ENFORCES, by writing against it.
--
-- Steps 2 and 3 prove the catalogue holds the right words. They do not prove
-- anything is refused: a CHECK added NOT VALID and later marked valid without a
-- scan, or one naming a column other than the one being written, reads exactly
-- the same in pg_constraint. So this writes.
--
-- BOTH DIRECTIONS ARE REQUIRED. A registered value must be ACCEPTED and an
-- unregistered value must be REFUSED. Testing only the refusal would pass on a
-- constraint that refuses everything, which would take the product down while
-- reading as green.
--
-- NOTHING THIS WRITES SURVIVES. The inner block carries an EXCEPTION clause,
-- which makes it a subtransaction, and it always leaves by raising, so the probe
-- row is rolled back whichever way the probe goes. The booleans are PL/pgSQL
-- variables and those are not rolled back with the subtransaction, which is what
-- lets the result outlive the writes. The slug and api_key_hash carry a uuid so
-- the probe cannot collide with a real row on either unique constraint.
DO $probe$
DECLARE
  v_slug     text    := 'orprobe-sink-' || gen_random_uuid()::text;
  v_accepted boolean := false;
  v_refused  boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.platforms (slug, name, api_key_hash, sink_format)
    VALUES (v_slug,
            'sink_format constraint probe, always rolled back',
            'orprobe-' || gen_random_uuid()::text,
            'bitbooks-v2');
    v_accepted := true;

    BEGIN
      UPDATE public.platforms
         SET sink_format = 'orangeway-books'
       WHERE slug = v_slug;
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;

    -- Always leave by raising, so the probe's write cannot outlive it.
    RAISE EXCEPTION USING ERRCODE = 'ORPRB', MESSAGE = 'probe finished';
  EXCEPTION WHEN SQLSTATE 'ORPRB' THEN
    NULL;
  END;

  IF NOT v_accepted THEN
    RAISE EXCEPTION 'assert failed: the probe could not store the REGISTERED value bitbooks-v2, so the constraint refuses a value it must admit';
  END IF;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'assert failed: sink_format was set to the unregistered value orangeway-books and ACCEPTED. The constraint is in the catalogue and is not enforcing.';
  END IF;

  RAISE NOTICE 'sink_format probe ok: registered value accepted, unregistered value refused, nothing left behind';
END
$probe$;
