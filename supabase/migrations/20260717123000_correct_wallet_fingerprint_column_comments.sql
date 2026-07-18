-- ============================================================
-- Correct the source_wallets.wallet_fingerprint column comments
-- ============================================================
-- 20260715130000 shipped two column comments that describe a key
-- scheme that was never built: a KMS key with GenerateMac, SQL
-- concat separators, a tenant_id field, the account domain
-- separator rather than the wallet one, and no currency field.
-- It also claimed the column is populated lazily on reconnect,
-- which nothing in the tree does. The real scheme is
-- computeWalletFingerprint in
-- supabase/functions/_shared/account-fingerprint.ts.
--
-- That file has been corrected at source, which is enough for any
-- database that has not applied it yet. Dev applied it on
-- 2026-07-15, so only a migration can reach dev's catalog. This
-- file carries the corrected text forward and makes the repo the
-- source of truth for what is in pg_catalog.
--
-- The COMMENT text below is byte-identical to the corrected text
-- in 20260715130000 so the two cannot drift.
--
-- Comments only. No DDL, no data touched, no index or constraint
-- touched. No CONCURRENTLY, so this one is transaction-safe and
-- can go through the CLI normally.
--
-- Undo: none needed. A COMMENT is overwritten by the next COMMENT
-- on the same column, so this is reversible by definition and
-- re-running it converges rather than doubling.
-- ============================================================

COMMENT ON COLUMN public.source_wallets.wallet_fingerprint IS
  'HMAC-SHA256 over the message "orangerails/wallet/v1" NUL subaccount_id NUL provider_type NUL canonical_account_key NUL currency, where NUL is the byte 0x00. '
  'Key is the env var OR_ACCT_FINGERPRINT_KEY_V1, imported sign-only via WebCrypto. Raw 32 bytes, not hex. '
  'Computed by computeWalletFingerprint in supabase/functions/_shared/account-fingerprint.ts, the only writer of this column. '
  'The domain separator "orangerails/wallet/v1" is load-bearing: this scheme shares its key with connections.account_fingerprint ("orangerails/acct/v1"), so the separator is the only guard keeping the two apart. '
  'currency is part of the message on purpose: one account key can expose one wallet per currency, and without it they all fingerprint identically. '
  'Internal dedup only. Never emitted to any client, API response, or log line. '
  'NULL for any row written without a widget session, including every row that predates this migration. Nothing backfills it: the dedup upsert conflicts on wallet_fingerprint alone and a NULL never matches a conflict target, so a reconnect inserts a fingerprinted row beside the NULL one rather than filling it in.';

COMMENT ON COLUMN public.source_wallets.wallet_fingerprint_key_version IS
  'Which version of OR_ACCT_FINGERPRINT_KEY_V1 wallet_fingerprint was computed under. '
  'v1 is permanent. Rotating the key changes every fingerprint, so the same wallet reconnects as a new one and duplicates instead of deduping. '
  'Any rotation must be preceded by a coordinated re-fingerprinting migration that rewrites every existing row under the new key before the old key is retired. '
  'This column records the version a row was computed under; it does not by itself make rotation safe. See the module header of account-fingerprint.ts for the rotation policy.';
