-- ============================================================
-- source_wallets: make the wallet_fingerprint unique index
-- inferable by a bare ON CONFLICT target
-- ============================================================
-- Problem this fixes:
--
-- The reconnect dedup write path (or-link-complete) upserts picked wallets
-- with a conflict target of wallet_fingerprint alone. A bare ON CONFLICT
-- target CANNOT infer a PARTIAL unique index. Postgres matches the arbiter at
-- plan time and requires the ON CONFLICT clause to carry an index predicate
-- that implies the index's own predicate; with no predicate supplied it skips
-- every partial index and raises:
--
--   42P10 there is no unique or exclusion constraint matching the
--         ON CONFLICT specification
--
-- Because that is a plan-time match, it fires on EVERY call that carries a
-- fingerprinted wallet, not only when two connects actually race.
--
-- Why the index and not the statement:
--
-- The write path goes through PostgREST (supabase-js .upsert). PostgREST's
-- on_conflict parameter takes a column list and has no syntax for an index
-- predicate, so the correct SQL, ON CONFLICT (wallet_fingerprint)
-- WHERE wallet_fingerprint IS NOT NULL, is unreachable from the client. No
-- conflict-target string fixes this. The index has to meet the client.
--
-- Why dropping the predicate is safe:
--
-- The predicate was never what made un-fingerprinted rows legal. Postgres
-- treats NULLs as distinct in a unique index (NULL != NULL), so a PLAIN unique
-- index on a nullable column already tolerates unlimited NULL rows. Migration
-- 20260715130000 relies on exactly that property and says so in its own header.
-- The predicate only kept the index lean. Removing it preserves the legacy
-- tokenless path byte for byte and makes the arbiter inferable.
--
-- Verified on dev before writing this file, on a temp-table replica of the live
-- index shape:
--   bare ON CONFLICT (fp) vs UNIQUE (fp) WHERE fp IS NOT NULL -> 42P10
--   bare ON CONFLICT (fp) vs UNIQUE (fp)                      -> inferred, dup dropped
--   three NULL fp rows under UNIQUE (fp)                      -> all three legal
--   NULL fp through the same upsert                           -> still inserts
--
-- Properties:
--   Additive:    creates the new index before dropping the old one, so the
--                uniqueness guarantee is never off, not even briefly.
--   Idempotent:  IF NOT EXISTS / IF EXISTS throughout. Re-running converges.
--   Reversible:  undo written at the bottom. Nothing is destroyed: this swaps
--                one index for a strictly broader one over the same column, so
--                no row is rewritten and no data of record is lost.
--   Lock safety: CONCURRENTLY on both create and drop, so a live
--                source_wallets table is never locked against writes.
--
-- CONCURRENTLY note: neither CREATE INDEX CONCURRENTLY nor DROP INDEX
-- CONCURRENTLY may run inside a transaction block. The DBA applies this file
-- statement by statement outside a transaction and owns the execution context,
-- the same as 20260715130000.
-- ============================================================

-- Step 1: the new, inferable arbiter. Plain unique index, no predicate.
-- This is also the FIRST time this tree declares a single-column unique index
-- on wallet_fingerprint. The live dev database carries an equivalent partial
-- index that no migration here creates, so without this file the index the
-- write path depends on would never reach another environment.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uq_source_wallets_wallet_fingerprint_v2
  ON public.source_wallets (wallet_fingerprint);

-- Step 2: retire the partial index the conflict target could never infer.
-- Dropped only after Step 1 is live, so uniqueness on wallet_fingerprint is
-- continuously enforced across the swap.
DROP INDEX CONCURRENTLY IF EXISTS public.uq_source_wallets_wallet_fingerprint;

COMMENT ON INDEX public.uq_source_wallets_wallet_fingerprint_v2 IS
  'Arbiter for the reconnect dedup upsert in or-link-complete. Deliberately NOT '
  'partial: a bare ON CONFLICT (wallet_fingerprint) target, which is all PostgREST '
  'can emit, cannot infer a partial index and raises 42P10 at plan time. NULLs are '
  'distinct in a unique index, so un-fingerprinted legacy rows remain legal without '
  'a WHERE clause. Do not add a predicate to this index: it would break the write path.';

-- Note on the composite index:
-- idx_source_wallets_connection_fingerprint (connection_id, wallet_fingerprint)
-- WHERE wallet_fingerprint IS NOT NULL is left exactly as 20260715130000 created
-- it. It is not the arbiter and is not touched here. subaccount_id is already
-- inside the MAC, so this single-column index is the correct uniqueness scope;
-- the composite one is left to that migration to own.

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- Restores the partial index and removes the plain one. Note that undoing this
-- file re-breaks the or-link-complete upsert with 42P10, so only run it
-- alongside a revert of the write path.
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     uq_source_wallets_wallet_fingerprint
--     ON public.source_wallets (wallet_fingerprint)
--     WHERE wallet_fingerprint IS NOT NULL;
--
--   DROP INDEX CONCURRENTLY IF EXISTS public.uq_source_wallets_wallet_fingerprint_v2;
