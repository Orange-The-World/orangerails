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
--   2. Compare p_app_user_id against that owner UNCONDITIONALLY, with
--      IS DISTINCT FROM, so a NULL or mismatched caller id always raises.
--      There is no service path exemption: the edge function is the only
--      caller and it passes the token-pinned caller identity.
--   3. Connection not found or no owner: reject, never write.
--
-- 4-arg signature (adds p_app_user_id TEXT): drops old 3-arg overload.
-- Grants: EXECUTE to service_role only (unchanged from PR #842).
--
-- Refs: DL-1597, residual of DL-1569

-- Drop the unguarded 3-arg overload so it cannot be called directly.
-- The guarded 4-arg replacement below is the only callable path after
-- this migration runs. DL-1597.
DROP FUNCTION IF EXISTS public.record_stealth_scan_range(uuid, int, int);

CREATE OR REPLACE FUNCTION public.record_stealth_scan_range(
  p_connection_id UUID,
  p_from_height   INT,
  p_to_height     INT,
  p_app_user_id   TEXT
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

  -- Unconditional ownership check. p_app_user_id must exactly match the owner
  -- from the stealth_connections row. IS DISTINCT FROM treats NULL as a
  -- mismatch: a NULL or wrong caller id always raises. No role escape.
  IF p_app_user_id IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'record_stealth_scan_range: caller % does not own connection %',
      p_app_user_id, p_connection_id
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

COMMENT ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text) IS
  'Merge-on-insert writer for stealth_scan_ranges. Ownership enforced '
  'unconditionally: p_app_user_id must match the owner from the '
  'stealth_connections row (IS DISTINCT FROM, so NULL always raises). '
  'No role escape. The edge function is the only caller and passes the '
  'CALLER identity from the request, token-pinned before the call, never '
  'the owner it read from this connection row: passing that would compare '
  'the owner against itself and the check could never fail. '
  'DL-1478, DL-1597.';

-- Grants unchanged from PR #842: service_role only.
REVOKE ALL ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int, text) TO service_role;
