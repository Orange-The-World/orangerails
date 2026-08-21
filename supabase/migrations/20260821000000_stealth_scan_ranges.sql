-- stealth_scan_ranges: persistent scan coverage map for stealth sync (DL-1478)
--
-- Replaces the single last_block_scanned cursor with a set of non-overlapping
-- [from_height, to_height] intervals per connection. The SECURITY DEFINER
-- function record_stealth_scan_range() merges on insert, keeping the set
-- normalized: every write produces disjoint, non-adjacent intervals.
--
-- Resume logic: to_height of the range that contains birthdayHeight (i.e.
--   from_height <= birthdayHeight AND to_height >= birthdayHeight),
-- else birthdayHeight itself. Computed at query time by the caller.
--
-- Not a ZKA surface: block heights are not keys, seeds, or user plaintext.
-- No Auditor pass required.
--
-- RLS: enabled. Owner reads via app_user_id join on stealth_connections.
-- Writes: service role only (no INSERT/UPDATE/DELETE policy). Use the
-- SECURITY DEFINER function record_stealth_scan_range() to write.
--
-- Undo (dev only):
--   DROP TABLE IF EXISTS public.stealth_scan_ranges;
--   DROP FUNCTION IF EXISTS public.record_stealth_scan_range(uuid, int, int);
--
-- Refs: DL-1478

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stealth_scan_ranges (
  connection_id  UUID  NOT NULL
                       REFERENCES public.stealth_connections(id) ON DELETE CASCADE,
  from_height    INT   NOT NULL,
  to_height      INT   NOT NULL,

  CONSTRAINT stealth_scan_ranges_pk
    PRIMARY KEY (connection_id, from_height),

  CONSTRAINT stealth_scan_ranges_height_check
    CHECK (from_height >= 0 AND from_height <= to_height)
);

COMMENT ON TABLE public.stealth_scan_ranges IS
  'Non-overlapping scan coverage intervals per stealth connection. '
  'Maintained exclusively by record_stealth_scan_range(), which merges on '
  'insert. Resume height = to_height of the birthday-anchored range, else '
  'birthdayHeight. Introduced DL-1478.';

COMMENT ON COLUMN public.stealth_scan_ranges.connection_id IS
  'FK to stealth_connections.id. Cascade-deleted when the parent row is removed.';

COMMENT ON COLUMN public.stealth_scan_ranges.from_height IS
  'Inclusive start of a contiguously scanned block range (>= 0).';

COMMENT ON COLUMN public.stealth_scan_ranges.to_height IS
  'Inclusive end of a contiguously scanned block range (>= from_height).';

-- ── 2. Additional index ───────────────────────────────────────────────────────
-- The PK already covers (connection_id, from_height). Add a covering index
-- that includes to_height for the birthday-anchor range lookup:
--   WHERE connection_id = $1 AND from_height <= $2 AND to_height >= $2

CREATE INDEX IF NOT EXISTS stealth_scan_ranges_coverage_idx
  ON public.stealth_scan_ranges (connection_id, from_height, to_height);

-- ── 3. Row Level Security ─────────────────────────────────────────────────────

ALTER TABLE public.stealth_scan_ranges ENABLE ROW LEVEL SECURITY;

-- Owners read their own ranges via the parent connection's app_user_id.
DROP POLICY IF EXISTS "Owners can read their stealth scan ranges"
  ON public.stealth_scan_ranges;

CREATE POLICY "Owners can read their stealth scan ranges"
  ON public.stealth_scan_ranges
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.stealth_connections sc
      WHERE sc.id          = stealth_scan_ranges.connection_id
        AND sc.app_user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    )
  );

-- No INSERT/UPDATE/DELETE policy. Only the service role (which bypasses RLS)
-- may write, exclusively through record_stealth_scan_range() below.

-- ── 4. SECURITY DEFINER merge writer ─────────────────────────────────────────
--
-- record_stealth_scan_range(p_connection_id, p_from_height, p_to_height)
--
-- Merges [p_from_height, p_to_height] into the stored set for p_connection_id.
-- Adjacent ranges (b = p_from - 1 or a = p_to + 1) are also merged so the
-- invariant "no two stored ranges overlap or touch" is maintained after every
-- call.
--
-- Algorithm:
--   1. Find min(from_height) and max(to_height) of all existing ranges that
--      overlap or are adjacent to the new interval.
--   2. If none, insert the new interval as-is and return.
--   3. Otherwise compute merged_from = LEAST(overlap_min, p_from),
--      merged_to = GREATEST(overlap_max, p_to).
--   4. Delete all ranges in [merged_from, merged_to] for this connection.
--   5. Insert the single merged range.

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
  v_overlap_from INT;
  v_overlap_to   INT;
  v_merged_from  INT;
  v_merged_to    INT;
BEGIN
  -- Collect the span of all existing ranges that overlap or touch [p_from, p_to].
  -- Adjacency: a range [a, b] with b = p_from - 1 or a = p_to + 1 merges too.
  SELECT MIN(from_height), MAX(to_height)
    INTO v_overlap_from, v_overlap_to
    FROM public.stealth_scan_ranges
   WHERE connection_id = p_connection_id
     AND from_height  <= p_to_height   + 1
     AND to_height    >= p_from_height - 1;

  IF v_overlap_from IS NULL THEN
    -- No overlapping or adjacent ranges exist: plain insert.
    INSERT INTO public.stealth_scan_ranges (connection_id, from_height, to_height)
    VALUES (p_connection_id, p_from_height, p_to_height);
    RETURN;
  END IF;

  -- Expand to cover both the overlapping existing ranges and the new interval.
  v_merged_from := LEAST(v_overlap_from,    p_from_height);
  v_merged_to   := GREATEST(v_overlap_to,   p_to_height);

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
  'Merge-on-insert writer for stealth_scan_ranges. Absorbs any existing ranges '
  'that overlap or are adjacent to [p_from_height, p_to_height] into one '
  'normalized interval. SECURITY DEFINER so the edge function can call it via '
  'service role without a direct INSERT policy on the table. DL-1478.';

-- Grant execute to service_role only; revoke from PUBLIC.
REVOKE ALL ON FUNCTION public.record_stealth_scan_range(uuid, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int) TO service_role;
