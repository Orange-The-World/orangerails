-- DL-0420 PR 1: stealth_utxos table + upsert_stealth_utxos RPC
--
-- Problem: src/stealth/lib/sync.ts builds utxoMap in-memory per runSync()
-- call. On incremental syncs the map starts empty, so any UTXO received in a
-- prior run is invisible. A spend of a pre-run UTXO is silently dropped.
--
-- Fix: persist the sealed UTXO set (one row per connection) so the widget
-- can pre-populate utxoMap before the filter scan begins.
--
-- ZKA constraint: UTXOs contain txid, vout index, value (sats), address.
-- The server must not read these. sealed_utxos holds AES-256-GCM ciphertext
-- produced client-side by sealEnvelope() in src/stealth/lib/seal.ts using
-- the per-connection orStealthKey. The server stores and returns the opaque
-- blob only. This migration and the RPC contain no decrypt path.
--
-- RLS: SELECT scoped to connection owner. No authenticated-user DML policies.
-- All writes go through upsert_stealth_utxos (SECURITY DEFINER, service_role
-- only). service_role bypasses RLS.
--
-- DL-0420

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stealth_utxos (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK to stealth_connections: one sealed UTXO set per connection/wallet.
  -- Cascade delete keeps the UTXO set consistent with its parent connection.
  connection_id UUID        NOT NULL
                            REFERENCES public.stealth_connections(id)
                            ON DELETE CASCADE,
  -- AES-256-GCM ciphertext of UtxoSetPayload, sealed client-side.
  -- Stored as jsonb (version, algorithm, iv_b64, ciphertext_b64) matching
  -- the stealth_transactions.sealed_record envelope shape.
  -- The server never holds the key; there is no decrypt path here.
  sealed_utxos  JSONB       NOT NULL,
  -- lastBlockScanned at time of save. The widget confirms this matches the
  -- sync cursor before using the persisted set (stale-set guard).
  scanned_to    INT         NOT NULL CHECK (scanned_to >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per connection: the upsert RPC replaces the set on each sync.
  UNIQUE (connection_id)
);

COMMENT ON TABLE public.stealth_utxos IS
  'Persists the sealed UTXO set across stealth sync runs. '
  'sealed_utxos is AES-256-GCM ciphertext (UtxoSetPayload) produced '
  'client-side; the server stores the opaque blob and has no decrypt path. '
  'DL-0420.';

COMMENT ON COLUMN public.stealth_utxos.sealed_utxos IS
  'Client-sealed UTXO set. Envelope shape: {version, algorithm, iv_b64, '
  'ciphertext_b64}. Plaintext is UtxoSetPayload sealed with sealEnvelope() '
  'in the browser widget. The server never holds the key.';

COMMENT ON COLUMN public.stealth_utxos.scanned_to IS
  'lastBlockScanned at save time. Widget discards the stored set if this '
  'does not match the current sync cursor (stale-set guard).';

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.stealth_utxos ENABLE ROW LEVEL SECURITY;

-- Authenticated users may SELECT their own row via connection ownership.
-- The predicate joins stealth_connections and checks app_user_id against
-- auth.uid()::text (the same ownership model used by stealth_connections).
-- No INSERT/UPDATE/DELETE policies: direct DML by authenticated users is
-- not permitted. All writes go through upsert_stealth_utxos (SECURITY
-- DEFINER, EXECUTE granted to service_role only).
-- service_role bypasses RLS entirely and needs no policy here.
DROP POLICY IF EXISTS "owner read via connection" ON public.stealth_utxos;
CREATE POLICY "owner read via connection" ON public.stealth_utxos
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.stealth_connections sc
       WHERE sc.id = stealth_utxos.connection_id
         AND sc.app_user_id = (auth.uid())::text
    )
  );

-- ── RPC: upsert_stealth_utxos ───────────────────────────────────────────────

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

  -- ── 2. Upsert ─────────────────────────────────────────────────────────────
  --
  -- Replace the stored UTXO set atomically. The sealed blob is stored opaque:
  -- no parsing, no decryption, no inspection of ciphertext content.
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
    updated_at   = EXCLUDED.updated_at;
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
  'DL-0420.';

-- Revoke from PUBLIC (covers anon and authenticated roles) before any grant.
REVOKE ALL ON FUNCTION public.upsert_stealth_utxos(uuid, jsonb, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_stealth_utxos(uuid, jsonb, int) TO service_role;
