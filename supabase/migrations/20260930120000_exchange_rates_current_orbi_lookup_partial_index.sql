-- OR-T0113: partial index for the current ORBI rate lookup on exchange_rates
--
-- Why
-- The rate coverage lookup asks for the first current row at or before a
-- requested time, for one asset, one fiat, one granularity and one product.
-- The existing unique index uq_rates_pair_bucket_authority orders by
-- bucket_ts before granularity, product and authority, so the planner reads
-- it as a forward walk over the whole currency pair and filters the other
-- columns row by row. When the requested group has no earlier row, that walk
-- crosses every other group of the pair before it can answer.
--
-- What
-- A partial btree index whose leading columns are the full group key
-- (source_currency, target_currency, granularity, product), then bucket_ts,
-- limited to the rows the lookup reads: source_authority = 'ORBI',
-- status = 'CONFIRMED' and superseded_by_id IS NULL. The same lookup then
-- becomes a bounded probe into one group. The point lookup that follows it
-- (latest row at or before the requested time) reads the same index
-- backward. The predicate must stay identical to the filters in
-- supabase/functions/v1-rate, otherwise the planner cannot use the index.
--
-- Applying
-- CREATE INDEX CONCURRENTLY builds without blocking writes, and cannot run
-- inside a transaction block, so this file must stay a single statement.
-- If a concurrent build is interrupted, an invalid index is left under this
-- name and IF NOT EXISTS would skip it: drop it (see Rollback) and run again,
-- and check pg_index.indisvalid after every build.
--
-- Scope
-- The migration pipeline applies this file to the databases it manages. The
-- large ORBI production database is not on that ledger, so the same statement
-- is applied there separately, under its own approval.
--
-- Rollback (comment only, never applied by the pipeline)
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_rates_current_orbi_lookup;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rates_current_orbi_lookup
  ON public.exchange_rates USING btree (source_currency, target_currency, granularity, product, bucket_ts)
  WHERE source_authority = 'ORBI' AND status = 'CONFIRMED' AND superseded_by_id IS NULL;
