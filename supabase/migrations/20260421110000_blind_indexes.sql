-- ============================================================
-- HMAC blind indexes on encrypted_transactions.
-- ============================================================
-- These columns store deterministic HMAC-SHA256 fingerprints of
-- plaintext field values so the server can filter/index without
-- ever seeing the plaintext. The HMAC key is derived from the
-- user's MEK via HKDF with a dedicated context:
--   orangerails-blind-index-v1
--
-- Indexed fields:
--   type         — filter by transaction type (lightning, onchain, …)
--   direction    — filter by in/out
--   counterparty — search for transactions with a specific counterparty
--
-- Wire format: base64( HMAC-SHA256( normalize(value), blindIndexKey ) )
-- Normalization: trim() + toLowerCase() before hashing.
-- NULL means the source field was absent or empty.

ALTER TABLE public.encrypted_transactions
  ADD COLUMN IF NOT EXISTS hmac_type         TEXT,
  ADD COLUMN IF NOT EXISTS hmac_direction    TEXT,
  ADD COLUMN IF NOT EXISTS hmac_counterparty TEXT;

-- Partial indexes — skip NULLs so index entries only cover populated rows.
CREATE INDEX IF NOT EXISTS idx_enc_txns_hmac_type
  ON public.encrypted_transactions(connection_id, hmac_type)
  WHERE hmac_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_enc_txns_hmac_direction
  ON public.encrypted_transactions(connection_id, hmac_direction)
  WHERE hmac_direction IS NOT NULL;

-- counterparty is searched across connections (no connection_id prefix needed).
CREATE INDEX IF NOT EXISTS idx_enc_txns_hmac_counterparty
  ON public.encrypted_transactions(hmac_counterparty)
  WHERE hmac_counterparty IS NOT NULL;

COMMENT ON COLUMN public.encrypted_transactions.hmac_type IS
  'HMAC-SHA256 blind index of NormalizedTransaction.type. Enables server-side filtering by tx type without plaintext exposure.';

COMMENT ON COLUMN public.encrypted_transactions.hmac_direction IS
  'HMAC-SHA256 blind index of NormalizedTransaction.direction (in/out).';

COMMENT ON COLUMN public.encrypted_transactions.hmac_counterparty IS
  'HMAC-SHA256 blind index of NormalizedTransaction.counterparty. Enables counterparty search without plaintext exposure.';
