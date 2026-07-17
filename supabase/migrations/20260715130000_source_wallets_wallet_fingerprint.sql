-- ============================================================
-- source_wallets: add wallet_fingerprint for reconnect dedup
-- ============================================================
-- Purpose: store a server-side keyed fingerprint (HMAC-SHA256)
-- used ONLY to answer "have we seen this account before?" across
-- session and device boundaries. Never emitted to clients.
--
-- Scheme (as implemented in
-- supabase/functions/_shared/account-fingerprint.ts,
-- computeWalletFingerprint, the only writer of this column):
--
--   wallet_fingerprint = HMAC-SHA256(
--     key  = env var OR_ACCT_FINGERPRINT_KEY_V1,
--     msg  = "orangerails/wallet/v1" NUL subaccount_id NUL
--            provider_type NUL canonical_account_key NUL currency
--   )
--
-- where NUL is the byte 0x00. The result is stored as the raw 32
-- bytes, not hex: this column is BYTEA, unlike
-- connections.account_fingerprint, which is text hex.
--
-- The domain separator "orangerails/wallet/v1" is load-bearing.
-- This scheme and the connections.account_fingerprint scheme share
-- one key, so the domain separator is the only guard keeping the
-- two apart. They must never be equal.
--
-- currency is part of the message on purpose. A provider can expose
-- one wallet per currency under a single account key; without
-- currency every one of them fingerprints identically and they
-- dedup onto each other.
--
-- ZKA status: wallet_fingerprint stores a non-reversible
-- HMAC-SHA256 output. No plaintext key material and no user key
-- material is stored in this column, and the value is never
-- emitted to a client, an API response, or a log line.
-- OR_ACCT_FINGERPRINT_KEY_V1 is a server-side operational key, not
-- a user key.
--
-- Backfill: NONE, and nothing backfills later either. Existing
-- rows stay NULL for the life of the row.
-- Postgres unique indexes tolerate multiple NULLs (NULL != NULL
-- in SQL), so the index is safe immediately with existing rows.
--
-- A row is fingerprinted only when it is written through a widget
-- session that recorded the provider account key server-side. The
-- legacy tokenless path has no widget session, so it has no account
-- key, so it cannot fingerprint: it writes NULL today and will keep
-- writing NULL until REQUIRE_WIDGET_TOKEN is true everywhere. NULL
-- is therefore an ongoing state, not a pre-migration artifact that
-- drains away.
--
-- Nothing fills a NULL in later. The dedup upsert conflicts on
-- wallet_fingerprint alone, and a NULL never matches a conflict
-- target, so a reconnect inserts a fingerprinted row beside the NULL
-- one rather than updating it. Dedup for un-fingerprinted rows rests
-- on the legacy constraint UNIQUE (connection_id, external_wallet_id),
-- which continues to work unchanged.
--
-- Undo analysis: the columns themselves are removable by
-- DROP COLUMN, but doing so after any row carries fingerprint
-- data destroys all dedup history and breaks any code path
-- that writes or reads wallet_fingerprint. There is no rollback
-- that restores prior behavior once fingerprint data exists.
-- Plan and approve before applying to prod.
--
-- CONCURRENTLY note: CREATE UNIQUE INDEX CONCURRENTLY cannot
-- run inside a transaction block. If applying via Supabase CLI
-- (which wraps migrations in an implicit transaction), run Step 1
-- (the ALTER TABLE) in one pass, then run Step 2 (the CREATE
-- INDEX CONCURRENTLY) separately outside a transaction. The DBA
-- applies this manually and owns the execution context.
-- ============================================================

-- Step 1: add columns (idempotent, safe inside a transaction)
ALTER TABLE public.source_wallets
  ADD COLUMN IF NOT EXISTS wallet_fingerprint BYTEA,
  ADD COLUMN IF NOT EXISTS wallet_fingerprint_key_version SMALLINT;

-- Step 2: unique partial index (must run OUTSIDE a transaction block)
-- CONCURRENTLY: no table lock, safe on a live source_wallets table.
-- IF NOT EXISTS: idempotent; re-running never wedges.
-- WHERE NOT NULL: excludes the NULL rows from existing pre-migration
-- data, keeping the index lean and the NULL tolerance explicit.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_source_wallets_connection_fingerprint
  ON public.source_wallets (connection_id, wallet_fingerprint)
  WHERE wallet_fingerprint IS NOT NULL;

-- Column comments (visible in Supabase dashboard and pg_catalog)
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
