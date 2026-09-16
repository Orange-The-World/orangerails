-- Assertion helpers for the scan-range SQL suite (DL-1856).
--
-- Loaded AFTER the migrations, not with the bootstrap, because it reads
-- public.stealth_scan_ranges and that table does not exist until the
-- migrations have been applied.
--
-- Why the helper renders the WHOLE set rather than counting rows: every case
-- in this suite turns on the difference between [100,250] and [100,200], and
-- a row count says "1" to both. Comparing the rendered set is what makes an
-- assertion able to fail for the right reason.

CREATE OR REPLACE FUNCTION public.t_ranges(p_conn uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_out text;
BEGIN
  SELECT coalesce(
           string_agg(format('[%s,%s]', from_height, to_height), ' ' ORDER BY from_height),
           '(none)')
    INTO v_out
    FROM public.stealth_scan_ranges
   WHERE connection_id = p_conn;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.t_assert_ranges(p_label text, p_conn uuid, p_expected text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_got text;
BEGIN
  v_got := public.t_ranges(p_conn);
  IF v_got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED [%]: expected % but the table holds %',
      p_label, p_expected, v_got;
  END IF;
  RAISE NOTICE 'ok  %  ->  %', p_label, v_got;
END;
$$;

-- Asserts that a call is REFUSED. The suite needs this as much as it needs
-- the merge cases: a guard that has only ever been observed permitting is not
-- a guard anyone has tested.
CREATE OR REPLACE FUNCTION public.t_assert_refused(
  p_label       text,
  p_conn        uuid,
  p_from        int,
  p_to          int,
  p_app_user_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_raised  boolean := false;
  v_message text;
BEGIN
  BEGIN
    PERFORM public.record_stealth_scan_range(p_conn, p_from, p_to, p_app_user_id);
  EXCEPTION WHEN OTHERS THEN
    v_raised  := true;
    v_message := SQLERRM;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'ASSERTION FAILED [%]: the call was ACCEPTED and it must be refused', p_label;
  END IF;

  RAISE NOTICE 'ok  %  ->  refused: %', p_label, v_message;
END;
$$;
