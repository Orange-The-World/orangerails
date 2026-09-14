-- 20260831060000_stealth_transactions_reorg_columns.sql
--
-- Reorg detection, step one of two: give stealth_transactions somewhere to record
-- WHICH block a transaction was found in, and somewhere to mark it when that block
-- turns out to no longer be on the canonical chain.
--
-- WHY
-- Bitcoin occasionally rewrites its most recent block or two. A transaction we have
-- already recorded can therefore stop existing. Nothing in the sync path looks back,
-- so the customer keeps seeing money that is not there, permanently, and no error is
-- raised. We cannot even detect it today: this table stores block_height but not
-- block_hash, so there is nothing to compare against the canonical chain. And with
-- nowhere to record the finding, the only way to take the amount off the screen would
-- be to delete a customer's row, which is ruled out.
--
-- WHAT
--   block_hash   text        NULL  canonical hash of the block this transaction was
--                                  found in, lowercase hex, as reported by the data
--                                  source at scan time. NULL means the row predates us
--                                  storing it: permanently unverifiable, NOT an error.
--   orphaned_at  timestamptz NULL  set when a later sync finds the stored block_hash no
--                                  longer matches the canonical hash at that height.
--                                  NULL means not orphaned.
--
-- CONSTRAINTS ON THE SHAPE, and why each one is deliberate.
--
-- 1. BOTH COLUMNS ARE NULLABLE AND STAY NULLABLE. Rows written before this change
--    genuinely have no hash and there is no honest value to invent for them. A NOT NULL
--    with a placeholder would make "we never knew" indistinguishable from "we checked
--    and it matched", which is precisely the ambiguity this change exists to remove.
--
-- 2. NOTHING IS EVER DELETED. orphaned_at exists so that a correction is achieved by
--    FILTERING rather than by destroying a customer's row. There is no ON DELETE clause
--    here and there must be no cleanup job built on top of this.
--
-- 3. NO BACKFILL AND NO DEFAULT. Adding a nullable column with no default is a catalog
--    only change in PostgreSQL: the table is not rewritten and no existing row is read
--    or touched. The assertion block below proves no value was written.
--
-- 4. ZERO KNOWLEDGE POSTURE IS UNCHANGED, stated here so the next reader does not have
--    to work it out. block_hash is PUBLIC CHAIN DATA, the same class as block_height,
--    which this table already stores in plaintext beside the sealed record. Neither new
--    column carries a customer secret, neither can be read back to a customer without
--    the sealed record, and the sealed record is untouched. This is not a self-custody
--    or encryption surface and needs no such review.
--
-- 5. NO INDEX, and the reason is recorded rather than left implicit. The query the
--    sibling change will run is "every row for this connection whose block_height is
--    within 100 of the tip and whose orphaned_at is null". Row counts were read live on
--    2026-08-31 before deciding, not assumed: production holds 29 rows and dev holds 17.
--    At that size a sequential scan beats any index and an index would only add write
--    amplification. Revisit when this table passes a few thousand rows on production.
--
-- REVERSIBILITY. This is not a one way street. To undo:
--    ALTER TABLE public.stealth_transactions DROP COLUMN IF EXISTS orphaned_at;
--    ALTER TABLE public.stealth_transactions DROP COLUMN IF EXISTS block_hash;
--  Safe to run only while nothing has written values into them, which is true for as
--  long as the sibling sync change has not shipped.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, so a re-run is a no-op rather than an error.
-- Transactional: the assertion block aborts the whole thing if the result is not the
-- shape described above.
--
-- Refs: OR-T0998, OR-T0407

BEGIN;

ALTER TABLE public.stealth_transactions
  ADD COLUMN IF NOT EXISTS block_hash  text        NULL,
  ADD COLUMN IF NOT EXISTS orphaned_at timestamptz NULL;

COMMENT ON COLUMN public.stealth_transactions.block_hash IS
  'Canonical hash of the block this transaction was found in, lowercase hex, as reported by the data source at scan time. NULL means the row was recorded before we started storing it, which is permanently unverifiable rather than an error. Public chain data, carries no customer secret. OR-T0998, OR-T0407.';

COMMENT ON COLUMN public.stealth_transactions.orphaned_at IS
  'Set when a later sync finds the stored block_hash no longer matches the canonical hash at that height. NULL means not orphaned. Correction is by filtering on this column, never by deleting a customer row. OR-T0998, OR-T0407.';

-- Prove the result, in this transaction, or abort. Each property that the ruling
-- pins is asserted by name: existence, nullability, type, absence of a default, and
-- absence of any written value. A migration that only asserts "the column exists"
-- would pass just as happily after someone added a NOT NULL placeholder default.
DO $$
DECLARE
  v_bh_nullable text;
  v_oa_nullable text;
  v_bh_type     text;
  v_oa_type     text;
  v_bh_default  text;
  v_oa_default  text;
BEGIN
  SELECT is_nullable, data_type, column_default INTO v_bh_nullable, v_bh_type, v_bh_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='stealth_transactions' AND column_name='block_hash';
  IF v_bh_nullable IS NULL THEN
    RAISE EXCEPTION 'FAIL: stealth_transactions.block_hash was not created';
  END IF;
  IF v_bh_nullable <> 'YES' THEN
    RAISE EXCEPTION 'FAIL: block_hash must stay NULLABLE, is_nullable=%', v_bh_nullable;
  END IF;
  IF v_bh_type <> 'text' THEN
    RAISE EXCEPTION 'FAIL: block_hash must be text, got %', v_bh_type;
  END IF;
  IF v_bh_default IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: block_hash must carry NO default, got %', v_bh_default;
  END IF;

  SELECT is_nullable, data_type, column_default INTO v_oa_nullable, v_oa_type, v_oa_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='stealth_transactions' AND column_name='orphaned_at';
  IF v_oa_nullable IS NULL THEN
    RAISE EXCEPTION 'FAIL: stealth_transactions.orphaned_at was not created';
  END IF;
  IF v_oa_nullable <> 'YES' THEN
    RAISE EXCEPTION 'FAIL: orphaned_at must stay NULLABLE, is_nullable=%', v_oa_nullable;
  END IF;
  IF v_oa_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'FAIL: orphaned_at must be timestamptz, got %', v_oa_type;
  END IF;
  IF v_oa_default IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: orphaned_at must carry NO default, got %', v_oa_default;
  END IF;

  IF EXISTS (SELECT 1 FROM public.stealth_transactions WHERE block_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: a backfill wrote block_hash on existing rows; this migration must write no values';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stealth_transactions WHERE orphaned_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: a backfill wrote orphaned_at on existing rows; this migration must write no values';
  END IF;

  RAISE NOTICE 'OR-T0998 ok: block_hash and orphaned_at added, both nullable, no default, no backfill';
END $$;

COMMIT;
