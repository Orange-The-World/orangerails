-- ORBI Phase D.1 — multi-authority source tagging on exchange_rates
--
-- Lets multiple authoritative records coexist for the same
-- (source_currency, target_currency, bucket_ts, granularity, product) tuple.
--
-- Why: Mexican, Brazilian and Canadian tax authorities legally require the
-- central bank's published rate (Banxico FIX, BCB PTAX, Bank of Canada noon /
-- daily reference) for tax/IFRS reporting. Our ORBI VW-median rate is the
-- right answer for market-rate use cases (transaction valuation, cross-rate
-- composites), but customers in those jurisdictions need the sovereign rate
-- on the same dates. Both must be queryable side by side without one
-- overwriting the other.
--
-- This migration is non-blocking: the DEFAULT lets Postgres skip a table
-- rewrite (Postgres 11+ behaviour). The live forward-fill writes, the
-- Bitstamp historical backfill, the Kraken backfill, and the reconciler
-- can all keep running while this migration is applied.
--
-- Existing rows will all be tagged 'ORBI' by the default — correct for
-- forward-fill, reconciler, and BTC historical-backfill output.
--
-- FOLLOW-UP FOUNDER ACTION (do NOT include in this migration):
--   Frankfurter-sourced rows were imported before this column existed and
--   are technically ECB-authoritative. Run a one-off:
--     UPDATE exchange_rates SET source_authority = 'ECB'
--     WHERE source_currency = 'USD' AND target_currency IN (...fiat list...)
--       AND product = 'ORBI-D' AND tier IN ('B-single','stable')
--       AND ...verify Frankfurter origin via provenance/provider_count...
--   Identify the exact set before running. Confirm against
--   exchange_rate_resolutions if needed.

ALTER TABLE exchange_rates
  ADD COLUMN source_authority text NOT NULL DEFAULT 'ORBI'
  CHECK (source_authority IN (
    'ORBI', 'ECB', 'BANXICO', 'BCB', 'BOC',
    'FED', 'BOE', 'RBA', 'SNB', 'BOJ', 'BLOCKCHAIN_COM'
  ));

CREATE INDEX exchange_rates_source_authority_idx
  ON exchange_rates (source_authority);

COMMENT ON COLUMN exchange_rates.source_authority IS
  'Which institution published this rate. ORBI = our multi-source VW-median rate; central-bank codes (BANXICO, BCB, BOC, etc.) = sovereign reference rates for tax/IFRS use.';

-- ----------------------------------------------------------------------------
-- Extend uniqueness to include source_authority
--
-- The current unique constraint is:
--   uq_rates_pair_bucket UNIQUE (source_currency, target_currency,
--                                bucket_ts, granularity, product)
-- (see orbi/schema/001_create_tables.sql).
--
-- That collides when ORBI publishes USD/MXN at bucket_ts X and BANXICO also
-- publishes USD/MXN at bucket_ts X. We need both rows. Replace with the same
-- tuple + source_authority.
-- ----------------------------------------------------------------------------

ALTER TABLE exchange_rates
  DROP CONSTRAINT IF EXISTS uq_rates_pair_bucket;

ALTER TABLE exchange_rates
  ADD CONSTRAINT uq_rates_pair_bucket_authority
  UNIQUE (source_currency, target_currency, bucket_ts, granularity, product, source_authority);

COMMENT ON CONSTRAINT uq_rates_pair_bucket_authority ON exchange_rates IS
  'One published rate per (pair, bucket, granularity, product, authority). ORBI and BANXICO can both publish USD/MXN at the same bucket without collision.';

-- ----------------------------------------------------------------------------
-- IMPORTANT — coordinated change required before applying this migration
--
-- Forward-fill (orbi/scripts/forward-fill.ts), the historical-backfill batch
-- writer (orbi/scripts/historical-backfill/lib/batch-writer.ts), and any
-- other writers currently use:
--   ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product)
--
-- After this migration runs, that exact 5-tuple is no longer unique on its
-- own — UPSERTs that reference it will fail with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Coordination required:
--   1. Apply this migration during a brief writer pause, OR
--   2. Update writers FIRST to include source_authority in ON CONFLICT
--      (defaulting to 'ORBI'), then apply this migration.
--
-- Phase D.1 explicitly scopes the writer updates as out-of-scope for this
-- agent (Phase B.2 owns historical-backfill internals, Phase A owns
-- forward-fill). The founder will sequence the writer updates before
-- applying migration 006.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Extend chk_product_valid to cover the new 'ORBI-D-authority' product code.
--
-- Background: ORBI-M (minute, market) and ORBI-D (day, market) are the
-- volume-weighted-median products. Sovereign-authority daily rates are a
-- different product because they aren't market rates and aren't computed
-- via VW-median — they're verbatim re-publications of a central bank's
-- official figure. Distinct product code keeps the calculate/ engine
-- from accidentally treating them as VW-median inputs.
-- ----------------------------------------------------------------------------

ALTER TABLE exchange_rates DROP CONSTRAINT IF EXISTS chk_product_valid;
ALTER TABLE exchange_rates
  ADD CONSTRAINT chk_product_valid
  CHECK (product IN ('ORBI-M','ORBI-D','ORBI-D-authority'));
