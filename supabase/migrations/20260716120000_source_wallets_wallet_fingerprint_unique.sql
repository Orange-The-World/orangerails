-- Unique backstop on source_wallets.wallet_fingerprint to close the TOCTOU race
-- in the or-link-complete dedup path (PR #153).
--
-- Two concurrent connects can each pass the SELECT-then-INSERT existence check
-- and both insert. The existing (connection_id, wallet_fingerprint) partial
-- unique index does not catch this: the partial-reconnect path mints a NEW
-- connection for new wallets, so the two racing inserts carry different
-- connection_id values and both are accepted. A partial unique index on the
-- fingerprint alone rejects the second insert regardless of connection.
--
-- Null fingerprints (legacy callers that omit currency) are excluded from the
-- index and remain free to duplicate, which preserves prior behavior.
--
-- Reversible: DROP INDEX IF EXISTS uq_source_wallets_wallet_fingerprint;
-- Idempotent: IF NOT EXISTS guard, safe to re-run.
--
-- PROD NOTE: on prod, build this CONCURRENTLY (outside a transaction) to avoid
-- blocking writes on source_wallets while the index builds. The statement below
-- is the transactional form used for dev; the CTO should apply the CONCURRENTLY
-- variant when this reaches prod.

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_wallets_wallet_fingerprint
  ON public.source_wallets (wallet_fingerprint)
  WHERE wallet_fingerprint IS NOT NULL;
