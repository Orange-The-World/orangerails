-- Extended statistics for the ORBI exchange_rates coverage-probe columns.
--
-- Ticket: OR-T0113 (BTC to non-USD fiat returns HTTP 500 from the v1-rate
-- endpoint for some pairs, e.g. BTC-EUR/1m/ORBI-M).
--
-- ROOT CAUSE, verified live on orbi-prod this session (plain EXPLAIN, no
-- execution, zero cost):
--
--   explain select bucket_ts from exchange_rates
--    where source_currency='BTC' and target_currency='EUR'
--      and granularity='1m' and product='ORBI-M' and source_authority='ORBI'
--      and status='CONFIRMED' and superseded_by_id is null
--      and bucket_ts <= '2024-06-15T12:00:00Z'
--    order by bucket_ts asc limit 1;
--
--   ->  Index Scan using uq_rates_pair_bucket_authority on exchange_rates
--       (cost=0.56..1553302.23 rows=2758621 width=8)
--
-- The planner picks uq_rates_pair_bucket_authority (source_currency,
-- target_currency, bucket_ts, granularity, product, source_authority)
-- instead of idx_rates_lookup (source_currency, target_currency,
-- granularity, product, bucket_ts desc), which already matches this
-- query's equality-then-range shape almost exactly. Earlier EXPLAIN
-- ANALYZE evidence on this ticket (same query, same pair) measured the
-- consequence of that wrong choice directly: 35,326.896 ms actual time,
-- 0 rows returned, against a LIMIT 1 lookup that should be sub-second.
--
-- Confirmed via pg_stats and pg_statistic_ext (both read-only, both
-- empty of any recorded correlation between these five columns) that
-- the planner has no way to know source_currency/target_currency/
-- granularity/product/source_authority are highly correlated for this
-- table. It assumes independence, multiplies per-column selectivities,
-- and drastically overestimates matching rows for high-volume, narrow
-- combinations like this one. That overestimate is what makes the
-- (objectively wrong) unique-index scan look cheaper than it is.
--
-- FIX: record the real joint selectivity so the planner can cost this
-- correctly. This changes no data, drops no index, and cannot change
-- what any query returns, only which plan is chosen.
--
-- Idempotent: IF NOT EXISTS guard, safe to re-run.
-- Risk: near zero. CREATE STATISTICS takes no lock beyond a normal DDL
-- catalog update; ANALYZE takes SHARE UPDATE EXCLUSIVE, which blocks
-- neither reads nor writes.
--
-- Applies cleanly to dev and orange-rails-prod via this repo's normal
-- migration pipeline. NOTE: orbi-prod (sqcventmypowhbaceufy), where the
-- production defect actually lives, is a separate Supabase project that
-- is not wired to this repo's migration ledger (verified: sb_migrations
-- returns no rows for it). Applying this statement there is a separate,
-- explicitly gated production DDL action (sb_request_write + Auditor
-- sql_approvals), not a side effect of merging this file.
--
-- Reversible: see the UNDO block at the foot of this file.

create statistics if not exists exchange_rates_coverage_stats (ndistinct, dependencies)
  on source_currency, target_currency, granularity, product, source_authority
  from public.exchange_rates;

analyze public.exchange_rates;

-- UNDO (reversible):
--   drop statistics if exists public.exchange_rates_coverage_stats;
--   analyze public.exchange_rates;
