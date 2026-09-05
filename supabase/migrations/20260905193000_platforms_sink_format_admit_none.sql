-- Widen public.platforms.sink_format's CHECK to admit the explicit 'none'
-- no-sink sentinel (OR-T1208), alongside the sink formats a sink adapter
-- actually implements.
--
-- THE RULE THIS ENFORCES
--   platforms.sink_format may only hold a slug a sink adapter implements
--   (per 20260831193000), OR the literal 'none', which means the platform
--   was explicitly configured to have no sink at all. NULL still means
--   "never configured" and stays legal, unchanged from 20260831193000.
--
-- WHY THIS IS A SEPARATE MIGRATION AND NOT AN EDIT TO 20260831193000
--   A migration that already applied on a cluster is never edited in place;
--   the historical record of what that file asserted at the time it ran
--   would stop matching what actually ran. This widens the same constraint
--   forward instead.
--
-- ORDERING WITH THE CODE CHANGE
--   This migration and the code that makes resolveSinkFormatForPlatform and
--   both direct readers of the column treat 'none' as "no sink" (rather
--   than as an unrecognized format string) ship in the SAME pull request.
--   Applying this alone, before the code lands, is harmless: it only adds a
--   value nothing writes yet. Landing the code alone, before this applies,
--   is the dangerous order: a backfill or an operator could not store
--   'none' at all until this constraint admits it, so the code path that
--   depends on it existing would be unreachable, not incorrect. Shipping
--   them together in one PR removes the question of which must go first.
--
-- IDEMPOTENT
--   Re-running is a no-op: the DROP is guarded on pg_constraint by name, and
--   the ADD only fires when a constraint by that name is absent, so a
--   partial or repeated apply cannot fail or double-add.
--
-- REVERSIBLE
--   ALTER TABLE public.platforms DROP CONSTRAINT platforms_sink_format_registered;
--   ALTER TABLE public.platforms ADD CONSTRAINT platforms_sink_format_registered
--     CHECK (sink_format IS NULL OR sink_format IN ('bitbooks-v2', 'orangeway-me'));
--   Reverting only matters if some row has since been set to 'none'; until
--   the code that writes 'none' ships, no row can hold it, so an early
--   revert clears nothing.
--
-- LOCKING
--   Same profile as 20260831193000: ADD CONSTRAINT ... CHECK takes ACCESS
--   EXCLUSIVE on public.platforms and validates every row, on a table with
--   fewer than ten rows on every cluster measured. Momentary.

-- Step 1. Drop the narrower constraint if it is the one currently in place.
-- Guarded by name so re-running this file, or running it after a future
-- widening has already superseded it, is a no-op rather than an error.
DO $drop_old$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.platforms'::regclass
       AND conname  = 'platforms_sink_format_registered'
  ) THEN
    ALTER TABLE public.platforms DROP CONSTRAINT platforms_sink_format_registered;
  END IF;
END
$drop_old$;

-- Step 2. Re-add, widened to admit 'none'.
DO $constrain$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.platforms'::regclass
       AND conname  = 'platforms_sink_format_registered'
  ) THEN
    ALTER TABLE public.platforms
      ADD CONSTRAINT platforms_sink_format_registered
      CHECK (sink_format IS NULL OR sink_format IN ('bitbooks-v2', 'orangeway-me', 'none'));
  END IF;
END
$constrain$;

COMMENT ON CONSTRAINT platforms_sink_format_registered ON public.platforms IS
  'sink_format may only hold a slug registered in _shared/sinks/dispatch.ts, '
  'or the literal ''none'' meaning the platform was explicitly configured to '
  'have no sink. NULL still means never configured.';

-- Step 3. Prove the constraint is present, VALIDATED, admits EXACTLY the
-- new three-value set, and that no row was left behind holding anything
-- outside it. Same extraction-based comparison as 20260831193000, and for
-- the same reason: a substring test would pass a constraint that also
-- admitted a fourth, unregistered value.
DO $assert$
DECLARE
  v_def       text;
  v_validated boolean;
  v_residual  integer;
  v_admitted  text[];
  v_expected  text[] := ARRAY['bitbooks-v2', 'none', 'orangeway-me'];
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
     AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me', 'none');

  IF v_residual <> 0 THEN
    RAISE EXCEPTION 'assert failed: % row(s) hold a sink_format outside the admitted set', v_residual;
  END IF;

  RAISE NOTICE 'sink_format value domain ok: constraint present and validated, admits exactly %, 0 residual rows outside it', v_admitted;
END
$assert$;

-- Step 4. Prove the constraint ENFORCES in both directions: the new value
-- 'none' must be ACCEPTED, and a value outside the admitted set must still
-- be REFUSED. Nothing this writes survives; the probe subtransaction always
-- exits by raising, so its row is rolled back whichever way the probe goes.
DO $probe$
DECLARE
  v_slug      text    := 'orprobe-sink-' || gen_random_uuid()::text;
  v_accepted  boolean := false;
  v_refused   boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.platforms (slug, name, api_key_hash, sink_format)
    VALUES (v_slug,
            'sink_format none-admit probe, always rolled back',
            'orprobe-' || gen_random_uuid()::text,
            'none');
    v_accepted := true;

    BEGIN
      UPDATE public.platforms
         SET sink_format = 'orangeway-books'
       WHERE slug = v_slug;
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;

    RAISE EXCEPTION USING ERRCODE = 'ORPRB', MESSAGE = 'probe finished';
  EXCEPTION WHEN SQLSTATE 'ORPRB' THEN
    NULL;
  END;

  IF NOT v_accepted THEN
    RAISE EXCEPTION 'assert failed: the probe could not store the sentinel value ''none'', so the widened constraint still refuses it';
  END IF;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'assert failed: sink_format was set to the unregistered value orangeway-books and ACCEPTED. The constraint is in the catalogue and is not enforcing.';
  END IF;

  RAISE NOTICE 'sink_format none-admit probe ok: sentinel accepted, unregistered value still refused, nothing left behind';
END
$probe$;
