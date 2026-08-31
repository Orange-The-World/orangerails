-- 20260831120000_stealth_transactions_block_hash_check_and_orphan_filter.sql
--
-- Reorg detection, schema hardening for the detector introduced on
-- OR-T0999. Two independent changes, both requirements raised by the
-- Auditor's adversarial pass on OR-T0998 (OR-C0406), both landing here so
-- the detector does not need its own migration cycle to be safe to ship.
--
-- WHY #1: block_hash needs to be provably comparable.
-- The detector compares the block_hash we stored against the canonical
-- hash at that height with a byte comparison in Postgres, which is case
-- sensitive. block_hash carried no CHECK constraint: the column comment
-- said "lowercase hex" but nothing enforced it. A data source returning
-- uppercase or mixed-case hex, or a future change in how the value is
-- normalised on write, would make stored <> canonical for EVERY row it
-- wrote, at every height, and the detector would mark real, unreversed
-- transactions as orphaned. That is the exact harm this whole feature
-- exists to prevent, inverted, and it is worse than the bug being fixed:
-- an over-report has a chain-level explanation, a silent under-report of
-- someone's balance has none.
--
-- WHY #2: an orphaned row needs a place that actually stops showing it.
-- No code in this repo reads stealth_transactions back for a customer.
-- The table is read directly by the embedding app under RLS; sealed_record
-- is opaque to OR by design. So the ONLY place that can guarantee an
-- orphaned row disappears from every balance and every list, for every
-- embedder, without asking any of them to change a query, is this SELECT
-- policy. Server-side code that runs the detector uses the service role
-- key, which bypasses RLS, so it can still see and update orphaned rows.
--
-- WHAT
--   1. CHECK (block_hash IS NULL OR block_hash ~ '^[0-9a-f]{64}$') on
--      stealth_transactions. Same belt-and-suspenders pattern
--      txid_blind_index_hex already uses in application code
--      (BLIND_INDEX_HEX_RE in or-stealth-transactions-store); this is the
--      database-side floor underneath it.
--   2. The owner-read SELECT policy on stealth_transactions gains
--      `orphaned_at IS NULL`. A row the detector orphans stops being
--      selectable through this policy the instant orphaned_at is set.
--
-- CONSTRAINTS ON THE SHAPE.
--
-- 1. NO BACKFILL, NO TABLE REWRITE. The CHECK only evaluates existing rows
--    at creation time and every row today has block_hash NULL (checked
--    live the same day on OR-T0998: 0 of 18 dev rows, 0 of 29 prod rows),
--    so this is a fast catalog validation, not a scan of meaningful size,
--    and NOT VALID is not needed.
--
-- 2. BOTH CHANGES ARE NO-OPS UNTIL THE DETECTOR SHIPS. block_hash is NULL
--    on every row today, so the CHECK constrains nothing yet; orphaned_at
--    IS NULL is already true for every row, so the policy filters out
--    nothing yet. This migration is safe to land ahead of the detector
--    PR, not coupled to it.
--
-- 3. REVERSIBILITY. Not a one way street:
--      ALTER TABLE public.stealth_transactions
--        DROP CONSTRAINT IF EXISTS stealth_transactions_block_hash_lowercase_hex_chk;
--      DROP POLICY IF EXISTS "Owners can read their stealth transactions" ON public.stealth_transactions;
--      CREATE POLICY "Owners can read their stealth transactions"
--        ON public.stealth_transactions FOR SELECT
--        USING (EXISTS (SELECT 1 FROM public.stealth_connections sc
--                        WHERE sc.id = stealth_transactions.connection_id
--                          AND auth.uid()::text = sc.app_user_id::text));
--
-- 4. IDEMPOTENT. The constraint add is guarded by a pg_constraint existence
--    check (ALTER TABLE has no ADD CONSTRAINT IF NOT EXISTS in Postgres);
--    the policy replace uses DROP POLICY IF EXISTS before CREATE POLICY,
--    the same pattern migration 20260624000000 already established for
--    this exact policy.
--
-- Refs: OR-T0999, OR-T0998, OR-C0406, OR-T0407

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stealth_transactions'::regclass
       AND conname = 'stealth_transactions_block_hash_lowercase_hex_chk'
  ) THEN
    ALTER TABLE public.stealth_transactions
      ADD CONSTRAINT stealth_transactions_block_hash_lowercase_hex_chk
      CHECK (block_hash IS NULL OR block_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

DROP POLICY IF EXISTS "Owners can read their stealth transactions" ON public.stealth_transactions;

CREATE POLICY "Owners can read their stealth transactions"
  ON public.stealth_transactions
  FOR SELECT
  USING (
    orphaned_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.stealth_connections sc
      WHERE sc.id = stealth_transactions.connection_id
        AND auth.uid()::text = sc.app_user_id::text
    )
  );

-- Prove the result, in this transaction, or abort. Each property this
-- migration claims is asserted by name, not just "it ran with no error".
DO $$
DECLARE
  v_chk_exists boolean;
  v_pol_qual   text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stealth_transactions'::regclass
       AND conname = 'stealth_transactions_block_hash_lowercase_hex_chk'
  ) INTO v_chk_exists;
  IF NOT v_chk_exists THEN
    RAISE EXCEPTION 'FAIL: stealth_transactions_block_hash_lowercase_hex_chk was not created';
  END IF;

  SELECT qual::text INTO v_pol_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'stealth_transactions'
     AND policyname = 'Owners can read their stealth transactions';
  IF v_pol_qual IS NULL THEN
    RAISE EXCEPTION 'FAIL: the owner-read policy on stealth_transactions is missing';
  END IF;
  IF v_pol_qual NOT ILIKE '%orphaned_at IS NULL%' THEN
    RAISE EXCEPTION 'FAIL: the owner-read policy does not filter orphaned_at, got %', v_pol_qual;
  END IF;

  IF EXISTS (SELECT 1 FROM public.stealth_transactions WHERE block_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: a value landed in block_hash while adding its CHECK constraint, this migration must write no values';
  END IF;

  RAISE NOTICE 'OR-T0999 ok: block_hash CHECK constraint and orphaned-row RLS filter are live';
END $$;

COMMIT;
