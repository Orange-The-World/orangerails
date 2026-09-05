-- Atomic bad-sig counter increment for Strike webhook verification (OR-T2248).
--
-- or-strike-webhook/index.ts previously read strike_bad_sig_count with a
-- SELECT, computed count + 1 in application code, then wrote it back with a
-- separate UPDATE. Two webhook deliveries that fail signature verification
-- for the same connection at close to the same time can both read the same
-- starting count and both write count + 1, silently losing an increment.
-- That only delays the resubscribe threshold, it does not break correctness,
-- but there is no reason to carry the race when Postgres can compute the
-- new value from the current row under its own lock in a single statement.
--
-- This function replaces the read-then-write with one UPDATE: the new count
-- and the resubscribe flag are both derived from connections.strike_bad_sig_count
-- as it stands at execution time, so a concurrent caller can never observe or
-- act on a stale count. Returns true only on the delivery that actually
-- crosses the threshold, so the caller logs the crossing once instead of on
-- every delivery while the flag remains set.
CREATE OR REPLACE FUNCTION public.strike_bump_bad_sig(p_conn_id uuid, p_threshold integer)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE public.connections
    SET strike_bad_sig_count = CASE
          WHEN strike_bad_sig_count + 1 >= p_threshold THEN 0
          ELSE strike_bad_sig_count + 1
        END,
        strike_needs_resubscribe = CASE
          WHEN strike_bad_sig_count + 1 >= p_threshold THEN TRUE
          ELSE strike_needs_resubscribe
        END
    WHERE id = p_conn_id
    RETURNING strike_bad_sig_count AS new_count, strike_needs_resubscribe
  )
  SELECT new_count = 0 AND strike_needs_resubscribe FROM updated;
$$;

REVOKE ALL ON FUNCTION public.strike_bump_bad_sig(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.strike_bump_bad_sig(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.strike_bump_bad_sig(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.strike_bump_bad_sig(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.strike_bump_bad_sig(uuid, integer) IS
    'Atomically increments connections.strike_bad_sig_count and, once it crosses p_threshold, resets it to 0 and sets strike_needs_resubscribe. Called from or-strike-webhook on every bad-sig 401 (OR-T2248: replaces a select-then-update race with one UPDATE).';
