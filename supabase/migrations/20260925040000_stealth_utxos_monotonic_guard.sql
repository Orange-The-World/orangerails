-- Fix a last-write-wins race in upsert_stealth_utxos (OR-T0049, OR-C2085).
--
-- Problem, found by the Auditor's adversarial challenge OR-C2085 and
-- reproduced by dev-3: the RPC's ON CONFLICT DO UPDATE overwrote
-- sealed_utxos/scanned_to unconditionally, with no comparison against the
-- row's current scanned_to. Two overlapping sync runs for the same
-- connection_id (auto-sync vs manual "Sync now", a double-opened widget, or
-- a retry without cancelling the first run over the documented 10-15 minute
-- scan window) can both fetch the same starting state, scan independently,
-- and then race on the final upsert. Whichever store call lands last wins
-- unconditionally, silently dropping any UTXO only the other run found. A
-- later spend of that dropped UTXO is then never recognized as an outgoing
-- transaction, which is the exact behaviour OR-T0049's acceptance requires.
--
-- Fix: add a monotonic guard to the UPDATE branch. A write only replaces
-- the stored row when its scanned_to is at least as advanced as the row
-- already there, so a run that started from a stale cursor cannot clobber
-- a more current write from an overlapping run. Backward compatible: same
-- signature, same callers, no caller changes needed.
--
-- Residual risk, documented and accepted as a smaller follow-up if it ever
-- matters: two runs that finish at the exact same scanned_to are not
-- distinguished by this guard and fall back to last-write-wins between the
-- two. Closing that fully needs a real compare-and-swap (caller-supplied
-- expected-prior scanned_to) with a return-contract change plus retry logic
-- in src/stealth/lib/sync.ts, which is a larger, separate change.
--
-- ZKA: no change. sealed_utxos stays opaque ciphertext end to end; this
-- migration only adds a comparison on the plaintext integer cursor
-- scanned_to, and never inspects or decrypts sealed_utxos.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, safe to re-run.
-- Restore path: re-apply the prior CREATE OR REPLACE FUNCTION body from
-- supabase/migrations/20260825000000_stealth_utxos.sql to drop the guard.
-- Grants are untouched by this migration (EXECUTE stays service_role only,
-- as set by that same file); CREATE OR REPLACE FUNCTION does not alter them.
--
-- OR-T0049, OR-C2085.

CREATE OR REPLACE FUNCTION public.upsert_stealth_utxos(
  p_connection_id UUID,
  p_sealed_utxos  JSONB,
  p_scanned_to    INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner      TEXT;
  v_caller_uid TEXT;
BEGIN
  -- ── 0. Input validation ──────────────────────────────────────────────────
  IF p_sealed_utxos IS NULL THEN
    RAISE EXCEPTION 'upsert_stealth_utxos: sealed_utxos must not be null'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_scanned_to < 0 THEN
    RAISE EXCEPTION 'upsert_stealth_utxos: scanned_to must be non-negative'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 1. Authorization guard ────────────────────────────────────────────────
  --
  -- Resolve ownership from the authoritative stealth_connections row.
  -- Ownership is never supplied by the caller.
  SELECT sc.app_user_id
    INTO v_owner
    FROM public.stealth_connections sc
   WHERE sc.id = p_connection_id;

  IF NOT FOUND OR v_owner IS NULL THEN
    RAISE EXCEPTION 'upsert_stealth_utxos: connection % not found or has no owner',
      p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  -- When a JWT subject is present, enforce that the caller owns this
  -- connection. auth.uid() returns NULL on the service_role path (no JWT),
  -- so the IS NOT NULL guard skips the check for service_role callers.
  v_caller_uid := (auth.uid())::text;
  IF v_caller_uid IS NOT NULL AND v_caller_uid <> v_owner THEN
    RAISE EXCEPTION 'upsert_stealth_utxos: caller % does not own connection %',
      v_caller_uid, p_connection_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 2. Upsert, monotonic guard on scanned_to (OR-C2085) ───────────────────
  --
  -- Replace the stored UTXO set atomically. The sealed blob is stored opaque:
  -- no parsing, no decryption, no inspection of ciphertext content. The
  -- WHERE clause on the DO UPDATE is the race fix: a concurrent write from a
  -- run that started at an older cursor is silently ignored rather than
  -- clobbering a newer write, because its scanned_to is behind what is
  -- already stored. Ties (equal scanned_to) still resolve last-write-wins;
  -- see the migration header for why that residual case is accepted.
  INSERT INTO public.stealth_utxos (
    connection_id,
    sealed_utxos,
    scanned_to,
    updated_at
  )
  VALUES (
    p_connection_id,
    p_sealed_utxos,
    p_scanned_to,
    now()
  )
  ON CONFLICT (connection_id)
  DO UPDATE SET
    sealed_utxos = EXCLUDED.sealed_utxos,
    scanned_to   = EXCLUDED.scanned_to,
    updated_at   = EXCLUDED.updated_at
  WHERE stealth_utxos.scanned_to <= EXCLUDED.scanned_to;
END;
$$;

COMMENT ON FUNCTION public.upsert_stealth_utxos(uuid, jsonb, int) IS
  'Upsert the sealed UTXO set for a stealth connection. sealed_utxos is '
  'AES-256-GCM ciphertext (UtxoSetPayload) produced client-side; the server '
  'stores and returns it opaque with no decrypt path. '
  'Authorization: when auth.uid() IS NOT NULL the caller must own the target '
  'connection (ownership derived from stealth_connections row, never from '
  'caller-supplied arguments). Service-role path (auth.uid() IS NULL) '
  'proceeds on the authoritative row owner. '
  'Monotonic guard: the stored row is only replaced when the incoming '
  'scanned_to is at least as advanced as the row already there, so an '
  'overlapping run started from a stale cursor cannot clobber a newer write '
  '(OR-C2085). '
  'DL-0420, OR-T0049.';
