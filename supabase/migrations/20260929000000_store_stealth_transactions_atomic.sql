-- OR-T2457: store_stealth_transactions_atomic
--
-- Puts the generation check, the stealth_transactions INSERT and the cursor
-- patch into one plpgsql function that runs under a single row-level lock
-- (SELECT ... FOR UPDATE) on the stealth_connections row. Any concurrent
-- envelope reset that rotates scan_generation after the caller reads the
-- ownership row returns http_status 409 WITHOUT committing any transaction
-- rows, closing the TOCTOU race the two-step JS sequence left open.
--
-- Called from supabase/functions/or-stealth-transactions-store/index.ts
-- via serviceClient.rpc('store_stealth_transactions_atomic', {...}).
--
-- Parameters
--   p_connection_id   - the stealth connection uuid
--   p_platform_id     - caller's platform id (ownership bound)
--   p_generation      - scan_generation the caller read at sync start
--   p_rows            - jsonb array of row objects, each carrying:
--                         sealed_record (object), occurred_at (date string),
--                         block_height (int), txid_blind_index_hex (64-char
--                         lowercase hex), block_hash (hex string or null)
--   p_cursor_advance  - boundCursorAdvance() result from the JS caller
--                         (-1 when no advance: empty batch or all dupes)
--   p_sync_at         - timestamp to write to last_sync_at
--
-- Returns: jsonb { http_status, inserted }
--   http_status 200  normal success
--   http_status 404  connection not found (or does not belong to platform)
--   http_status 409  scan_generation mismatch: connection was reset since
--                    the caller read the ownership row; no rows inserted

CREATE OR REPLACE FUNCTION store_stealth_transactions_atomic(
  p_connection_id   uuid,
  p_platform_id     text,
  p_generation      text,
  p_rows            jsonb,
  p_cursor_advance  integer,
  p_sync_at         timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conn      record;
  v_inserted  bigint;
BEGIN
  -- Lock the stealth_connections row for this transaction's duration.
  -- No concurrent UPDATE (including an envelope reset that rotates
  -- scan_generation) can complete between here and the final UPDATE below,
  -- closing the TOCTOU window the JS two-step could not close.
  SELECT id, scan_generation, last_block_scanned
  INTO   v_conn
  FROM   stealth_connections
  WHERE  id          = p_connection_id
    AND  platform_id = p_platform_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('http_status', 404, 'inserted', 0);
  END IF;

  -- Generation mismatch: the connection was reset (envelope replaced) after
  -- the caller read the ownership row. Return 409; no rows are inserted.
  IF v_conn.scan_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('http_status', 409, 'inserted', 0);
  END IF;

  -- Insert the caller's transaction rows. ON CONFLICT DO NOTHING is a
  -- DB-side safety net; the caller already filters known duplicates before
  -- calling here.
  WITH ins AS (
    INSERT INTO stealth_transactions (
      connection_id,
      sealed_record,
      occurred_at,
      block_height,
      txid_blind_index_hex,
      block_hash
    )
    SELECT
      p_connection_id,
      (elem -> 'sealed_record'),
      (elem ->> 'occurred_at')::date,
      (elem ->> 'block_height')::integer,
      (elem ->> 'txid_blind_index_hex'),
      (elem ->> 'block_hash')
    FROM jsonb_array_elements(p_rows) AS elem
    ON CONFLICT (connection_id, txid_blind_index_hex) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  -- Advance the cursor only when rows actually landed and the bounded
  -- candidate height exceeds the stored cursor (forward-only guard, mirrors
  -- the JS deriveResponseCursor logic). scan_generation in the WHERE is
  -- belt-and-suspenders after the FOR UPDATE above.
  UPDATE stealth_connections
  SET    last_sync_at       = p_sync_at,
         last_block_scanned = CASE
           WHEN v_inserted > 0
             AND p_cursor_advance > COALESCE(v_conn.last_block_scanned, -1)
           THEN p_cursor_advance
           ELSE last_block_scanned
         END
  WHERE  id          = p_connection_id
    AND  platform_id = p_platform_id
    AND  scan_generation = p_generation;

  RETURN jsonb_build_object('http_status', 200, 'inserted', v_inserted);
END;
$$;
