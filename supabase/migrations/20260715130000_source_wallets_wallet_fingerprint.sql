-- ============================================================
-- source_wallets: add wallet_fingerprint for reconnect dedup
-- ============================================================
-- Purpose: store a server-side keyed fingerprint (HMAC-SHA256)
-- used ONLY to answer "have we seen this account before?" across
-- session and device boundaries. Never emitted to clients.
--
-- ZKA status: Auditor CLEARED 2026-07-15. wallet_fingerprint is
-- a non-reversible HMAC-SHA256 output. No plaintext key material
-- is stored in this column. Key (K_v) lives in KMS, GenerateMac
-- only, non-exportable. See: Knowledge > Connector fingerprint
-- key K_v (Auditor artifact) for the full checklist.
--
-- Backfill: NONE. Existing rows stay NULL.
-- Postgres unique indexes tolerate multiple NULLs (NULL != NULL
-- in SQL), so the index is safe immediately with existing rows.
-- wallet_fingerprint is written on first reconnect per user
-- (lazy re-keying). Existing dedup on the legacy constraint
-- UNIQUE (connection_id, external_wallet_id) continues to work
-- unchanged until all rows have been re-keyed.
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
  'HMAC-SHA256(K_v, "orangerails/acct/v1" || tenant_id || provider || canonical_account_key). '
  'Internal dedup only. Never emitted to any client or API response. '
  'Key held in AWS KMS (GenerateMac only, non-exportable, no offline oracle). '
  'NULL for rows created before this migration; populated lazily on reconnect.';

COMMENT ON COLUMN public.source_wallets.wallet_fingerprint_key_version IS
  'Key version (v) used to compute wallet_fingerprint. '
  'Supports lazy re-keying on K_v rotation without a big-bang migration.';
