-- ORBI Phase D.2 — Inventory Strength materialized view
--
-- One row per distinct (source_currency, target_currency, source_authority,
-- granularity) group in exchange_rates, scoring how strong our inventory of
-- that pair is on a 0-100 scale. The score blends five dimensions:
--
--   strength = 100 * (
--     0.30 * span_score      +
--     0.25 * density_score   +
--     0.20 * tier_score      +
--     0.15 * diversity_score +
--     0.10 * recency_score
--   )
--
-- span_score      = LEAST(span_years / 10, 1.0)
-- density_score   = LEAST(actual_rows / expected_rows, 1.0)
--                   where expected is span_minutes for 1m and
--                   span_business_days for 1d (5 business days per 7 cal days)
-- tier_score      = weighted mean over rows, A=1.0, B=0.7, B-single=0.4,
--                   C-composite=0.2 (canonical tier strings verified live
--                   2026-05-27: A, B, B-single, C-composite)
-- diversity_score = LEAST(unique_sources / 4, 1.0)
--                   Fallback: median provider_count across the pair's rows
--                   (capped at 4). exchange_rate_resolutions only covers
--                   live forward-fill VW-median runs, not historical
--                   backfill batches, so a clean join would understate
--                   diversity for the long-history pairs. provider_count
--                   is the consistent signal across both paths.
-- recency_score   = depends on granularity:
--                   1m: MAX(0, 1.0 - max(0, minutes_lag - 2) / 60)
--                   1d: MAX(0, 1.0 - max(0, days_lag - 2) / 14)
--
-- The view also exposes `weakest_dimension` and an auto-derived
-- `next_action` recommendation so the wiki page can render an
-- action-ranked table without business logic in the refresh script.
--
-- Reads CONFIRMED rows only (matches the public-read RLS policy on
-- exchange_rates).
--
-- Refresh: external cron on jarvis runs
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.orbi_pair_inventory_strength;
-- every 25 minutes alongside the existing Coverage Tracker refresh.
-- The UNIQUE INDEX below makes CONCURRENT refresh possible.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.orbi_pair_inventory_strength AS
WITH base AS (
  SELECT
    source_currency,
    target_currency,
    source_authority,
    granularity,
    tier,
    provider_count,
    bucket_ts,
    computed_at
  FROM public.exchange_rates
  WHERE status = 'CONFIRMED'
),
agg AS (
  SELECT
    source_currency,
    target_currency,
    source_authority,
    granularity,
    COUNT(*)::bigint                              AS row_count,
    MIN(bucket_ts)                                AS earliest,
    MAX(bucket_ts)                                AS latest,
    MAX(computed_at)                              AS latest_computed,
    -- span in years (capped at 10 for span_score)
    GREATEST(EXTRACT(EPOCH FROM (MAX(bucket_ts) - MIN(bucket_ts))) / 31557600.0, 0)::numeric
                                                  AS span_years,
    -- minutes between first and last bucket (for 1m density)
    GREATEST(EXTRACT(EPOCH FROM (MAX(bucket_ts) - MIN(bucket_ts))) / 60.0, 1)::numeric
                                                  AS span_minutes,
    -- business-day approx: calendar-days * 5/7 (for 1d density)
    GREATEST(EXTRACT(EPOCH FROM (MAX(bucket_ts) - MIN(bucket_ts))) / 86400.0 * (5.0/7.0), 1)::numeric
                                                  AS span_business_days,
    -- weighted average tier score
    AVG(
      CASE tier
        WHEN 'A'           THEN 1.0
        WHEN 'B'           THEN 0.7
        WHEN 'B-single'    THEN 0.4
        WHEN 'C-composite' THEN 0.2
        ELSE 0.0
      END
    )::numeric                                    AS tier_score_raw,
    -- mode_within_group gives us the dominant (most common) tier per group
    -- without a correlated subquery — keeps the refresh single-pass.
    mode() WITHIN GROUP (ORDER BY tier)            AS dominant_tier,
    -- diversity fallback: median provider_count across rows
    percentile_cont(0.5) WITHIN GROUP (ORDER BY provider_count)::numeric
                                                  AS median_provider_count
  FROM base
  GROUP BY source_currency, target_currency, source_authority, granularity
),
scored AS (
  SELECT
    source_currency,
    target_currency,
    source_authority,
    granularity,
    row_count,
    earliest,
    latest,
    span_years,
    -- actual_density and density_score
    CASE granularity
      WHEN '1m' THEN (row_count::numeric / NULLIF(span_minutes, 0))
      WHEN '1d' THEN (row_count::numeric / NULLIF(span_business_days, 0))
      ELSE 0
    END                                                   AS actual_density,
    LEAST(
      CASE granularity
        WHEN '1m' THEN (row_count::numeric / NULLIF(span_minutes, 0))
        WHEN '1d' THEN (row_count::numeric / NULLIF(span_business_days, 0))
        ELSE 0
      END,
      1.0
    )                                                     AS density_score,
    -- span_score
    LEAST(span_years / 10.0, 1.0)                         AS span_score,
    -- tier_score (already 0-1)
    tier_score_raw                                        AS tier_score,
    dominant_tier,
    -- diversity via provider_count fallback
    LEAST(GREATEST(median_provider_count, 1) / 4.0, 1.0)  AS diversity_score,
    GREATEST(median_provider_count, 1)::int               AS unique_sources,
    -- recency: minutes since latest bucket
    EXTRACT(EPOCH FROM (now() - latest)) / 60.0           AS minutes_since_latest,
    CASE granularity
      WHEN '1m' THEN GREATEST(
        0.0,
        1.0 - GREATEST(0.0, (EXTRACT(EPOCH FROM (now() - latest))/60.0) - 2.0) / 60.0
      )
      WHEN '1d' THEN GREATEST(
        0.0,
        1.0 - GREATEST(0.0, (EXTRACT(EPOCH FROM (now() - latest))/86400.0) - 2.0) / 14.0
      )
      ELSE 0.0
    END                                                   AS recency_score
  FROM agg
)
SELECT
  source_currency,
  target_currency,
  source_authority,
  granularity,
  row_count,
  earliest,
  latest,
  ROUND(span_years::numeric, 2)            AS span_years,
  ROUND(actual_density::numeric, 4)        AS actual_density,
  ROUND(density_score::numeric, 4)         AS density_score,
  ROUND(tier_score::numeric, 4)            AS tier_score,
  dominant_tier,
  unique_sources,
  ROUND(diversity_score::numeric, 4)       AS diversity_score,
  ROUND(minutes_since_latest::numeric, 2)  AS minutes_since_latest,
  ROUND(recency_score::numeric, 4)         AS recency_score,
  ROUND(span_score::numeric, 4)            AS span_score,
  ROUND(
    100.0 * (
      0.30 * span_score      +
      0.25 * density_score   +
      0.20 * tier_score      +
      0.15 * diversity_score +
      0.10 * recency_score
    )::numeric,
    2
  )                                        AS strength_score,
  -- weakest_dimension: lowest of the five normalized 0-1 scores
  (
    SELECT dim FROM (VALUES
      ('span',      span_score),
      ('density',   density_score),
      ('tier',      tier_score),
      ('diversity', diversity_score),
      ('recency',   recency_score)
    ) AS d(dim, val)
    ORDER BY val ASC
    LIMIT 1
  )                                        AS weakest_dimension,
  CASE
    WHEN 100.0 * (
      0.30 * span_score + 0.25 * density_score + 0.20 * tier_score +
      0.15 * diversity_score + 0.10 * recency_score
    ) >= 90.0 THEN 'Already strong — no immediate action'
    ELSE (
      SELECT
        CASE dim
          WHEN 'span'      THEN 'Backfill historical depth (paged API or vendor CSV)'
          WHEN 'density'   THEN 'Investigate gaps — reconciler or source dropouts'
          WHEN 'tier'      THEN 'Add more upstream sources to lift tier mix'
          WHEN 'diversity' THEN 'Add a second source to remove single-vendor risk'
          WHEN 'recency'   THEN 'Forward-fill or publishing pipeline broken; investigate'
        END
      FROM (VALUES
        ('span',      span_score),
        ('density',   density_score),
        ('tier',      tier_score),
        ('diversity', diversity_score),
        ('recency',   recency_score)
      ) AS d(dim, val)
      ORDER BY val ASC
      LIMIT 1
    )
  END                                      AS next_action
FROM scored;

-- Unique index enables REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS orbi_pair_inventory_strength_uidx
  ON public.orbi_pair_inventory_strength
  (source_currency, target_currency, source_authority, granularity);

-- Match the public-read pattern from 003_rls_public_read.sql.
-- Materialized views don't honour RLS (they're owned by the creator and read
-- as that role); a plain GRANT lets anon + authenticated SELECT the view.
GRANT SELECT ON public.orbi_pair_inventory_strength TO anon, authenticated;

COMMENT ON MATERIALIZED VIEW public.orbi_pair_inventory_strength IS
  'One row per (source_currency, target_currency, source_authority, granularity). Scores inventory strength 0-100 across span/density/tier/diversity/recency. Refreshed every 25 min by external cron on jarvis (refresh_inventory_strength.py). See orbi/schema/014_inventory_strength_view.sql.';
