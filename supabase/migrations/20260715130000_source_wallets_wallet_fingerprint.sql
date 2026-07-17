-- ============================================================
-- source_wallets: add wallet_fingerprint for reconnect dedup
-- ============================================================
-- Purpose: store a server-side keyed fingerprint (HMAC-SHA256)
-- used ONLY to answer "have we seen this account before?" across
-- session and device boundaries. Never emitted to clients.
--
-- Key handling: the MAC key is read from the OR_ACCT_FINGERPRINT_KEY_V1
-- env var on the Supabase project and the HMAC is computed in-process
-- via WebCrypto. It is NOT held in a managed KMS and there is no
-- non-exportable / GenerateMac-only property to rely on. Any statement
-- about this key's protection must be checked against
-- supabase/functions/_shared/account-fingerprint.ts before it is made.
--
-- ZKA: wallet_fingerprint is an HMAC-SHA256 output. No plaintext key
-- material is stored in this column. The ZKA question for the env-key
-- construction is the Auditor's to answer against the shipped code, and
-- their verdict lives in the Knowledge collection, not in this comment.
-- Do not cite this file as a clearance.
--
-- Backfill: NONE. Existing rows stay NULL.
-- Postgres unique indexes tolerate multiple NULLs (NULL != NULL
-- in SQL), so the index is safe immediately with existing rows.
-- wallet_fingerprint is populated lazily: it is written the first time a
-- given wallet is reconnected through the widget flow, because only that
-- flow records the provider account key server-side. Existing dedup on the
-- legacy constraint UNIQUE (connection_id, external_wallet_id) continues
-- to work unchanged for rows that have no fingerprint yet.
--
-- Re-keying: there is none, and none is planned. OR_ACCT_FINGERPRINT_KEY_V1
-- is permanent for v1. Rotating it does not lazily re-key: it silently
-- breaks dedup, because every existing wallet then computes a new
-- fingerprint, its stored row is never found, and each reconnect writes a
-- duplicate. Any rotation must be preceded by a coordinated
-- re-fingerprinting migration that rewrites every stored fingerprint under
-- the new key before the old key is retired.
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
--
-- This index is NOT the arbiter for the reconnect dedup upsert. The
-- arbiter is the plain unique index on wallet_fingerprint alone, created
-- by 20260716140000_source_wallets_fingerprint_arbiter_index.sql. Read
-- that file before changing anything about uniqueness on this table: a
-- bare ON CONFLICT target cannot infer a partial index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_source_wallets_connection_fingerprint
  ON public.source_wallets (connection_id, wallet_fingerprint)
  WHERE wallet_fingerprint IS NOT NULL;

-- Column comments (visible in Supabase dashboard and pg_catalog)
--
-- These strings are what a reviewer reads out of the catalog and treats as
-- fact, so they carry the full construction and a pointer to the code they
-- were checked against. They are kept byte for byte identical to the
-- comments live on dev.
COMMENT ON COLUMN public.source_wallets.wallet_fingerprint IS
'HMAC-SHA256(OR_ACCT_FINGERPRINT_KEY_V1, "orangerails/wallet/v1" \x00 subaccount_id \x00 provider_type \x00 canonical_account_key \x00 currency).
Five parts, NUL-joined (\x00), not plain concatenation: NUL joining is what stops two different field splits assembling to the same message. Every field is rejected if empty or if it contains a NUL byte.
currency is part of the message: a provider can expose one wallet per currency under one account key, and without currency they all collapse to one fingerprint and dedup onto each other.
Domain separator is "orangerails/wallet/v1" and it MUST NEVER equal DOMAIN_SEPARATOR ("orangerails/acct/v1") used by connections.account_fingerprint. The two schemes share one key, so the domain separator is the only guard keeping them apart.
Stored as raw 32 bytes (BYTEA), NOT hex. connections.account_fingerprint is hex text; this is not. Writing hex here would store 64 ASCII bytes instead of the 32 real ones: consistent enough to dedup, and wrong.
Key is read from the OR_ACCT_FINGERPRINT_KEY_V1 env var on the Supabase project and HMAC is computed in-process via WebCrypto.
Internal dedup only: never emitted, logged, or returned in any response body or error message. NULL for rows created before this migration; populated lazily on reconnect.
Source of truth, diff against it before trusting this text: supabase/functions/_shared/account-fingerprint.ts (computeWalletFingerprint).';

COMMENT ON COLUMN public.source_wallets.wallet_fingerprint_key_version IS
'Key version (v) of OR_ACCT_FINGERPRINT_KEY_V1 used to compute wallet_fingerprint.
This column does NOT enable lazy re-keying. OR_ACCT_FINGERPRINT_KEY_V1 is PERMANENT for v1. Rotating it silently breaks dedup: the same wallet computes a new fingerprint, the existing row is not found, and every reconnect writes a duplicate wallet row.
Any rotation MUST be preceded by a coordinated re-fingerprinting migration that rewrites every existing fingerprint under the new key before the old key is retired. Never rotate without that migration in place first.
Source of truth, diff against it before trusting this text: supabase/functions/_shared/account-fingerprint.ts (module header, rotation policy).';
