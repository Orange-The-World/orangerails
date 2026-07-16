-- ============================================================
-- source_wallets: reconcile the wallet_fingerprint unique indexes
-- ============================================================
-- Supersedes the index half of 20260715130000_source_wallets_wallet_fingerprint.
-- The columns that migration added are untouched here.
--
-- WHAT THIS FIXES
--
-- 20260715130000 declared:
--   UNIQUE (connection_id, wallet_fingerprint) WHERE wallet_fingerprint IS NOT NULL
--
-- The reconnect dedup write path names ON CONFLICT (wallet_fingerprint).
-- Postgres infers an arbiter index only from a unique index on exactly the
-- target column set, and for a partial index only when the index predicate is
-- implied by a predicate supplied in the ON CONFLICT clause. A composite index
-- is a different column set, so it is never inferred for that target and the
-- insert raises 42P10 (no unique or exclusion constraint matching the ON
-- CONFLICT specification) the first time it runs against a real database.
--
-- WHY THE SINGLE COLUMN IS THE RIGHT UNIQUENESS SCOPE
--
-- subaccount_id, provider_type, the canonical account key and currency are all
-- inputs to the fingerprint MAC, so the value already carries its own scope.
-- Scoping the index to a connection on top of that is both redundant and too
-- weak for the race it was meant to backstop: two concurrent connects that each
-- mint their own connection row hold two different connection_ids, so a
-- composite unique on (connection_id, wallet_fingerprint) never fires and both
-- duplicate wallets land. Uniqueness on the fingerprint alone is the invariant
-- the dedup depends on.
--
-- DRIFT THIS ALSO CLOSES
--
-- The dev database carries uq_source_wallets_wallet_fingerprint_v2, a unique
-- index on (wallet_fingerprint) with no predicate, which no migration in the
-- applied history declares. wallet_fingerprint did not exist before
-- 20260715130000 and that file creates only the composite index, so the v2
-- index reached the database outside the migration path. Two consequences, both
-- bad: dev silently satisfies ON CONFLICT (wallet_fingerprint) while prod would
-- raise 42P10, and an index nobody declared cannot be reasoned about or
-- reviewed. This file drops it and declares the index it was standing in for.
--
-- PROPERTIES
--
--   Additive first:  the new index is created before either old index is
--                    dropped, so there is never a window with no uniqueness
--                    backstop on the fingerprint.
--   Idempotent:      IF NOT EXISTS / IF EXISTS throughout. Re-running converges
--                    and never doubles or wedges.
--   Reversible:      undo written at the bottom. Nothing is rewritten and no
--                    row is touched, so the undo is exact.
--   Lock profile:    every step is CONCURRENTLY. No ACCESS EXCLUSIVE lock, so
--                    source_wallets stays writable throughout.
--
-- WHEN THIS CAN FAIL, AND THAT IS THE POINT
--
-- Step 1 tightens uniqueness from per-connection to global. On a table that
-- already holds the same fingerprint under two connections it fails and changes
-- nothing, which is the correct outcome: that data is the duplicate the dedup
-- exists to prevent, and it must be resolved deliberately, not by an index
-- build picking a winner. VERIFIED at time of writing: source_wallets holds
-- 0 rows in dev and the column does not exist in prod, so no existing row can
-- violate it. Re-check before applying anywhere else.
--
-- CONCURRENTLY note: neither CREATE INDEX CONCURRENTLY nor DROP INDEX
-- CONCURRENTLY can run inside a transaction block. The Supabase CLI wraps a
-- migration in an implicit transaction, so this file is applied by hand,
-- statement by statement, outside a transaction. The DBA owns the execution
-- context, the same way 20260715130000 was applied.
-- ============================================================

-- Step 1: the index the write path's conflict target actually infers.
-- Partial on IS NOT NULL: the rows from before the column existed carry NULL
-- and have nothing to dedup against, so they stay out of the index.
-- The calling statement must name the same predicate:
--   ON CONFLICT (wallet_fingerprint) WHERE wallet_fingerprint IS NOT NULL
-- Without it the predicate is not implied, the index is not inferred, and the
-- statement raises 42P10 against this index too.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uq_source_wallets_wallet_fingerprint
  ON public.source_wallets (wallet_fingerprint)
  WHERE wallet_fingerprint IS NOT NULL;

-- Step 2: drop the undeclared index. Step 1 holds the same uniqueness and more
-- (partial vs none over a column whose NULLs are distinct anyway), so nothing
-- is unguarded between these statements.
DROP INDEX CONCURRENTLY IF EXISTS public.uq_source_wallets_wallet_fingerprint_v2;

-- Step 3: drop the composite. It is not an arbiter for any conflict target the
-- write path names, its uniqueness is strictly weaker than Step 1's, and as a
-- lookup path it is already covered by idx_source_wallets_connection on
-- (connection_id). VERIFIED at time of writing: no ON CONFLICT clause anywhere
-- in supabase/functions names it, and or-link-complete on dev does not write
-- wallet_fingerprint at all yet.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_source_wallets_connection_fingerprint;

-- Step 4: correct the column comment.
-- 20260715130000 documented this column as
--   HMAC-SHA256(K_v, "orangerails/acct/v1" || tenant_id || provider || canonical_account_key)
-- which is the ACCOUNT fingerprint's construction, not this column's. The
-- wallet fingerprint uses a different domain separator and five fields, and the
-- two separators being unequal is the only thing separating the two schemes
-- under one shared key. A comment describing the wrong construction is worse
-- than none: the next reader takes it for the spec.
COMMENT ON COLUMN public.source_wallets.wallet_fingerprint IS
  'HMAC-SHA256(K_v, "orangerails/wallet/v1" || subaccount_id || provider_type || canonical_account_key || currency), NUL-joined. '
  'Raw bytes, not hex: this column is BYTEA where connections.account_fingerprint is text. '
  'Internal dedup only. Never emitted to any client, API response, or log line. '
  'Unique globally where NOT NULL: the scope is inside the MAC, so the value needs no further scoping. '
  'NULL for rows created before 20260715130000; populated lazily on reconnect.';

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- Restores the index state 20260715130000 declared. It does NOT restore
-- uq_source_wallets_wallet_fingerprint_v2, which no migration ever declared and
-- which should not exist. Run outside a transaction.
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     idx_source_wallets_connection_fingerprint
--     ON public.source_wallets (connection_id, wallet_fingerprint)
--     WHERE wallet_fingerprint IS NOT NULL;
--
--   DROP INDEX CONCURRENTLY IF EXISTS public.uq_source_wallets_wallet_fingerprint;
--
-- Undoing this file returns the write path to raising 42P10 on
-- ON CONFLICT (wallet_fingerprint), so undo the write path with it.
