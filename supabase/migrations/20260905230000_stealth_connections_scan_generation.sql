-- OR-T2457: fence a stale in-flight sync write from resurrecting the cursor
-- or coverage an envelope replacement just reset.
--
-- THE RACE THIS CLOSES. applyEnvelopeReplacement resets last_block_scanned to
-- NULL and clears stealth_scan_ranges when a user re-adds a wallet or changes
-- its birthday. advanceCursor's forward-only guard is
-- `last_block_scanned.lt.X OR last_block_scanned.is.null`, so once the cursor
-- is NULL, ANY write is accepted, including one queued before the reset from
-- a sync of the OLD envelope. record_stealth_scan_range cannot tell a
-- pre-reset write from a fresh one either: it checks only that the caller
-- owns the connection. Either write can land a pre-reset height back onto a
-- just-reset connection, and the next sync silently resumes above the new
-- birthday instead of rescanning it. No error, no flag: OR-T1203's coverage
-- clear closed one door into this defect and left this one open.
--
-- THE FIX. scan_generation is a token that changes every time the envelope is
-- replaced. A sync reads it at the START of a sync and must echo it back on
-- the cursor and coverage writes; a write whose token does not match the
-- CURRENT value predates a reset that has since happened and is refused
-- rather than silently accepted. It is a random token, not a counter,
-- because no caller ever compares two generations to each other, only to the
-- current one, and a random value needs no atomic increment to stay
-- race-free across two concurrent envelope replacements.

ALTER TABLE public.stealth_connections
  ADD COLUMN IF NOT EXISTS scan_generation UUID NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN public.stealth_connections.scan_generation IS
  'Fencing token for the scan cursor and coverage writes (OR-T2457). '
  'Rotated by applyEnvelopeReplacement on every envelope replacement. A sync '
  'reads this at its start and must echo it back on the cursor/coverage '
  'write; a mismatch means the connection was reset mid-sync and the write '
  'is refused rather than silently accepted.';

-- record_stealth_scan_range gains the same fence. 5-arg signature: drops the
-- 4-arg overload from 20260824000000 so a caller cannot bypass the check by
-- omitting the new argument.
DROP FUNCTION IF EXISTS public.record_stealth_scan_range(uuid, int, int, text);

CREATE OR REPLACE FUNCTION public.record_stealth_scan_range(
  p_connection_id   UUID,
  p_from_height     INT,
  p_to_height       INT,
  p_app_user_id     TEXT,
  p_scan_generation UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_overlap_from  INT;
  v_overlap_to    INT;
  v_merged_from   INT;
  v_merged_to     INT;
  v_owner         TEXT;
  v_generation    UUID;
BEGIN
  SELECT sc.app_user_id, sc.scan_generation
    INTO v_owner, v_generation
    FROM public.stealth_connections sc
   WHERE sc.id = p_connection_id;

  IF NOT FOUND OR v_owner IS NULL THEN
    RAISE EXCEPTION 'record_stealth_scan_range: connection % not found or has no owner',
      p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_app_user_id IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'record_stealth_scan_range: caller % does not own connection %',
      p_app_user_id, p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  -- OR-T2457: reject a write carrying a generation from before the most
  -- recent envelope replacement. IS DISTINCT FROM so a NULL token (a caller
  -- that skipped reading it) is also refused, never treated as a match.
  IF p_scan_generation IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'record_stealth_scan_range: stale scan_generation for connection % (reset since this sync began)',
      p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(1478, hashtext(p_connection_id::text));

  SELECT MIN(from_height), MAX(to_height)
    INTO v_overlap_from, v_overlap_to
    FROM public.stealth_scan_ranges
   WHERE connection_id = p_connection_id
     AND from_height  <= (p_to_height::bigint   + 1)
     AND to_height    >= (p_from_height::bigint  - 1);

  IF v_overlap_from IS NULL THEN
    INSERT INTO public.stealth_scan_ranges (connection_id, from_height, to_height)
    VALUES (p_connection_id, p_from_height, p_to_height);
    RETURN;
  END IF;

  v_merged_from := LEAST(v_overlap_from,  p_from_height);
  v_merged_to   := GREATEST(v_overlap_to, p_to_height);

  DELETE FROM public.stealth_scan_ranges
   WHERE connection_id = p_connection_id
     AND from_height  <= v_merged_to
     AND to_height    >= v_merged_from;

  INSERT INTO public.stealth_scan_ranges (connection_id, from_height, to_height)
  VALUES (p_connection_id, v_merged_from, v_merged_to);
END;
$$;

COMMENT ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text, uuid) IS
  'Merge-on-insert writer for stealth_scan_ranges. Ownership enforced '
  'unconditionally, and the write is refused unless p_scan_generation '
  'matches the connection''s current scan_generation (OR-T2457): a stale '
  'value means the connection was reset mid-sync. The edge function is the '
  'only caller and passes the CALLER identity and the generation it read at '
  'the start of the sync, never a value read back from this connection row. '
  'DL-1478, DL-1597, OR-T2457.';

-- Grants: service_role only, matching every prior overload of this function.
-- The DROP + CREATE makes a new object, and the public schema's default ACL
-- re-grants EXECUTE to anon and authenticated on every new function unless
-- explicitly revoked (see 20260822031500 for why REVOKE ... FROM PUBLIC alone
-- does not do it).
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text, uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text, uuid)
      TO service_role;
  ELSE
    REVOKE EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text, uuid)
      FROM PUBLIC;
    RAISE NOTICE 'Supabase API roles absent on this database, revoked from PUBLIC only';
  END IF;
END
$grants$;

-- Post-condition, not the DO block above: prove the grants and the column
-- actually landed rather than trusting that the statements ran.
DO $verify$
DECLARE
  v_oid oid := to_regprocedure('public.record_stealth_scan_range(uuid,int,int,text,uuid)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FAIL: record_stealth_scan_range(uuid,int,int,text,uuid) does not exist after this migration created it';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stealth_connections'
       AND column_name = 'scan_generation'
  ) THEN
    RAISE EXCEPTION 'FAIL: stealth_connections.scan_generation was not created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon still holds EXECUTE on record_stealth_scan_range(uuid,int,int,text,uuid)';
  END IF;

  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated still holds EXECUTE on record_stealth_scan_range(uuid,int,int,text,uuid)';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost EXECUTE on record_stealth_scan_range(uuid,int,int,text,uuid)';
  END IF;
END
$verify$;
