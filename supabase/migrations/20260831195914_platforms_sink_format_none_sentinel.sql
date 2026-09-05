-- Widen public.platforms.sink_format's registered-value CHECK to admit
-- 'none', the explicit no-sink sentinel.
--
-- THE RULE THIS ENFORCES
--   sink_format may hold NULL (not yet configured), a slug registered in
--   supabase/functions/_shared/sinks/dispatch.ts (a real sink adapter), or
--   the literal string 'none' (this platform deliberately has no sink,
--   backfilled rather than left NULL). resolveSinkFormatForPlatform in
--   _shared/quiltt-config.ts, changed in this same PR, maps 'none' to null
--   before or-sync ever reads it, so or-sync's sink-mode check never has
--   to know the sentinel exists.
--
-- WHY THIS SHIPS WITH THE RESOLVER CHANGE, NOT AFTER IT
--   Migrations apply on merge to dev. If this constraint widened one merge
--   ahead of the resolver understanding 'none', there would be a window
--   where the database accepts a value the running or-sync cannot handle:
--   a stored 'none' would reach getSinkAdapter('none'), which returns null,
--   and or-sync would 400 "Unknown format: none". That window is
--   survivable today only because OR_SYNC_SINK_FORMAT_ENFORCE is off, and
--   this migration does not rely on that flag staying off.
--
-- ORDER AGAINST 20260831193000 (PR #1047)
--   This version (20260831195914) sorts after it, so on a cluster that
--   applies migrations in filename order, 20260831193000 always runs
--   first. This migration does not assume that happened, in case a rebuild
--   ever applies it out of that order: step 1 re-derives the full
--   registered set from scratch rather than only adding to whatever
--   constraint it finds, so it is correct whether or not 20260831193000
--   has run.
--
-- IDEMPOTENT
--   Re-running is a no-op: the constraint is dropped and recreated with
--   the same definition each time, and step 1's clear matches nothing once
--   the column already only holds registered values.
--
-- REVERSIBLE
--   Restore the two-value CHECK from 20260831193000:
--     ALTER TABLE public.platforms DROP CONSTRAINT platforms_sink_format_registered;
--     ALTER TABLE public.platforms ADD CONSTRAINT platforms_sink_format_registered
--       CHECK (sink_format IS NULL OR sink_format IN ('bitbooks-v2', 'orangeway-me'));
--   Any row this migration's step 1 clears to NULL is not restored by
--   dropping the constraint; on the clusters measured on 2026-08-31 no row
--   holds a value outside {NULL, bitbooks-v2, orangeway-me} yet, so step 1
--   is expected to clear nothing when this runs after 20260831193000.
--
-- LOCKING
--   Same as 20260831193000: ADD CONSTRAINT ... CHECK takes ACCESS
--   EXCLUSIVE and validates every row. The table holds fewer than ten rows
--   on every cluster measured, so the hold is momentary.

-- Step 1. Clear any stored value that is neither NULL, a registered sink,
-- nor the 'none' sentinel. Same clearing logic as 20260831193000, run
-- again here so this migration is correct even if that one has not
-- applied yet.
DO $clear$
DECLARE
  v_bad text;
  v_n   integer;
BEGIN
  SELECT string_agg(DISTINCT sink_format, ', '), count(*)
    INTO v_bad, v_n
    FROM public.platforms
   WHERE sink_format IS NOT NULL
     AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me', 'none');

  IF v_n > 0 THEN
    RAISE NOTICE 'sink_format: clearing % row(s) holding unregistered value(s): %', v_n, v_bad;
    UPDATE public.platforms
       SET sink_format = NULL
     WHERE sink_format IS NOT NULL
       AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me', 'none');
  ELSE
    RAISE NOTICE 'sink_format: no unregistered values stored, nothing cleared';
  END IF;
END
$clear$;

-- Step 2. Widen the constraint. Drop-and-recreate rather than
-- add-if-missing so this is correct regardless of whether
-- 20260831193000 already created the narrower, two-value version.
DO $constrain$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.platforms'::regclass
       AND conname  = 'platforms_sink_format_registered'
  ) THEN
    ALTER TABLE public.platforms
      DROP CONSTRAINT platforms_sink_format_registered;
  END IF;

  ALTER TABLE public.platforms
    ADD CONSTRAINT platforms_sink_format_registered
    CHECK (sink_format IS NULL OR sink_format IN ('bitbooks-v2', 'orangeway-me', 'none'));
END
$constrain$;

COMMENT ON CONSTRAINT platforms_sink_format_registered ON public.platforms IS
  'sink_format may only hold a slug registered in _shared/sinks/dispatch.ts, '
  'or the literal ''none'' (explicit no-sink, mapped to null by '
  'resolveSinkFormatForPlatform before or-sync sees it). Adding an adapter '
  'means adding its slug here in the same change. NULL stays legal for a '
  'platform not yet configured.';

-- Step 3. Prove the constraint is present, VALIDATED, admits all three
-- registered values, still refuses an unregistered one, and that an
-- explicit insert of an unregistered value is rejected live (not just
-- inferred from the definition text). Written to be able to FAIL: each
-- check names what it found.
DO $assert$
DECLARE
  v_def       text;
  v_validated boolean;
  v_residual  integer;
  v_rejected  boolean := false;
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
    RAISE EXCEPTION 'assert failed: constraint exists but is NOT VALID, so existing rows were never checked';
  END IF;

  IF v_def NOT LIKE '%bitbooks-v2%' OR v_def NOT LIKE '%orangeway-me%' OR v_def NOT LIKE '%none%' THEN
    RAISE EXCEPTION 'assert failed: constraint does not admit all three registered values, definition is: %', v_def;
  END IF;

  SELECT count(*) INTO v_residual
    FROM public.platforms
   WHERE sink_format IS NOT NULL
     AND sink_format NOT IN ('bitbooks-v2', 'orangeway-me', 'none');

  IF v_residual <> 0 THEN
    RAISE EXCEPTION 'assert failed: % row(s) still hold an unregistered sink_format after step 1', v_residual;
  END IF;

  -- Prove the widened CHECK did not simply open the column: a genuinely
  -- unregistered value must still be refused, demonstrated live.
  BEGIN
    INSERT INTO public.platforms (id, slug, name, api_key_hash, sink_format)
    VALUES (
      gen_random_uuid(),
      'or-t1249-constraint-probe',
      'OR-T1249 constraint probe (rolled back)',
      'or-t1249-constraint-probe-' || gen_random_uuid()::text,
      'not-a-real-sink'
    );
    -- If the insert succeeded, roll it back and fail loud: the constraint
    -- did not do its job.
    DELETE FROM public.platforms WHERE slug = 'or-t1249-constraint-probe';
    RAISE EXCEPTION 'assert failed: an insert of an unregistered sink_format (not-a-real-sink) was NOT refused';
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'assert failed: unregistered-value probe did not raise check_violation';
  END IF;

  RAISE NOTICE 'sink_format value domain ok: constraint present and validated, admits bitbooks-v2/orangeway-me/none, 0 residual unregistered rows, an unregistered value is live-refused, definition %', v_def;
END
$assert$;
