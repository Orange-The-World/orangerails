-- DL-1597: cross-tenant write guard for record_stealth_scan_range
--
-- A signed-in caller relayed through an edge function using service_role
-- could pass an arbitrary p_connection_id and write scan ranges against
-- another customer's stealth connection. PR #842 revoked EXECUTE from PUBLIC
-- and anon, but a JWT-bearing caller reaching the function via service_role
-- in an edge function remains unguarded.
--
-- This migration replaces record_stealth_scan_range with a version that
-- verifies connection ownership at the top of the body:
--
--   1. Always join stealth_connections on p_connection_id; read app_user_id
--      from that row (authoritative). Reject if not found or null.
--   2. JWT present (auth.uid() IS NOT NULL): reject unless caller matches owner.
--   3. Service path (auth.uid() IS NULL): proceed. No caller-supplied owner.
--   4. Connection not found or no owner: reject, never write.
--
-- Function signature is unchanged. No new parameters.
-- Grants are unchanged: EXECUTE to service_role only.
--
-- Refs: DL-1597, residual of DL-1569

CREATE OR REPLACE FUNCTION public.record_stealth_scan_range(
  p_connection_id UUID,
  p_from_height   INT,
  p_to_height     INT
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
  v_caller_uid    TEXT;
BEGIN
  -- ── 0. Authorization guard ────────────────────────────────────────────────
  --
  -- Resolve the connection's owner from the authoritative stealth_connections
  -- row. Ownership is never supplied by the caller.
  SELECT sc.app_user_id
    INTO v_owner
    FROM public.stealth_connections sc
   WHERE sc.id = p_connection_id;

  IF NOT FOUND OR v_owner IS NULL THEN
    RAISE EXCEPTION 'record_stealth_scan_range: connection % not found or has no owner',
      p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  -- When a JWT subject is present, enforce that the caller owns this connection.
  -- auth.uid() returns NULL in the service_role path (no JWT), so the service
  -- path is unaffected: the IS NOT NULL guard skips the ownership check.
  v_caller_uid := auth.uid()::text;
  IF v_caller_uid IS NOT NULL AND v_caller_uid <> v_owner THEN
    RAISE EXCEPTION 'record_stealth_scan_range: caller % does not own connection %',
      v_caller_uid, p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 1. Serialize per connection ───────────────────────────────────────────
  --
  -- Advisory lock prevents two concurrent callers for the same connection_id
  -- from producing overlapping rows or a PK collision. Released at txn end.
  -- Namespace 1478 = DL-1478; hashtext maps the UUID to int4.
  PERFORM pg_advisory_xact_lock(1478, hashtext(p_connection_id::text));

  -- ── 2. Merge overlapping / adjacent ranges ────────────────────────────────
  --
  -- Collect the span of all existing ranges that overlap or touch [p_from, p_to].
  -- A range [a, b] with b = p_from - 1 or a = p_to + 1 is adjacent and merges.
  -- Cast to bigint before +1/-1 to avoid overflow at INT max/min.
  SELECT MIN(from_height), MAX(to_height)
    INTO v_overlap_from, v_overlap_to
    FROM public.stealth_scan_ranges
   WHERE connection_id = p_connection_id
     AND from_height  <= (p_to_height::bigint   + 1)
     AND to_height    >= (p_from_height::bigint  - 1);

  IF v_overlap_from IS NULL THEN
    -- No overlapping or adjacent ranges exist: plain insert.
    INSERT INTO public.stealth_scan_ranges (connection_id, from_height, to_height)
    VALUES (p_connection_id, p_from_height, p_to_height);
    RETURN;
  END IF;

  -- Expand to cover both the overlapping existing ranges and the new interval.
  v_merged_from := LEAST(v_overlap_from,  p_from_height);
  v_merged_to   := GREATEST(v_overlap_to, p_to_height);

  -- Remove all ranges subsumed by the merged span.
  DELETE FROM public.stealth_scan_ranges
   WHERE connection_id = p_connection_id
     AND from_height  <= v_merged_to
     AND to_height    >= v_merged_from;

  -- Insert the single normalized merged range.
  INSERT INTO public.stealth_scan_ranges (connection_id, from_height, to_height)
  VALUES (p_connection_id, v_merged_from, v_merged_to);
END;
$$;

COMMENT ON FUNCTION public.record_stealth_scan_range(uuid, int, int) IS
  'Merge-on-insert writer for stealth_scan_ranges. When a JWT subject is '
  'present (auth.uid() IS NOT NULL), rejects unless the caller owns the '
  'target connection (ownership derived from stealth_connections row -- no '
  'caller-supplied owner parameter). Service-role path (no JWT) proceeds on '
  'the authoritative row owner. DL-1478, DL-1597.';

-- Grants unchanged from PR #842: service_role only.
REVOKE ALL ON FUNCTION public.record_stealth_scan_range(uuid, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int) TO service_role;
