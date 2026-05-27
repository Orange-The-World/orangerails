-- ORBI migration 011 — register ECB / RBA / SNB / BoJ central-bank sources.
--
-- Phase D.3 ships four sovereign-rail plug-ins to round out central-bank
-- coverage on the major fiat pairs:
--   ECB  — Eurozone daily reference rates direct from the ECB SDW Data API.
--          Replaces the Frankfurter proxy as the authority chain for
--          USD/EUR and the EUR-crosses we already serve.
--   RBA  — Reserve Bank of Australia F11 daily AUD/USD. Akamai-blocked
--          from cloud IPs; the plug-in runs from jarvis via the wrapper at
--          /home/kiwi/bin/run-rba-backfill.sh and writes to OR PROD over
--          the pooler URL.
--   SNB  — Swiss National Bank daily CHF reference rates. Tries SDMX CSV
--          first, falls back to Playwright table extraction.
--   BoJ  — Bank of Japan 5pm Tokyo fixings. Legacy Shift_JIS encoding;
--          decoded via TextDecoder('shift_jis').
--
-- Shipped ACTIVE because every endpoint is open public data with stable
-- contracts. Founder still gates the first live backfill via the
-- orchestrator dry-run pattern (see scripts/central-banks/README.md).
--
-- The four sources fill out the exchange_rate_providers registry — they
-- do NOT themselves write to that table at backfill time. Plug-ins write
-- to exchange_rates with source_authority = '<CODE>'.

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('ecb', 'primary', TRUE,
   'https://data-api.ecb.europa.eu/service/data/EXR',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["USD-EUR","EUR-GBP","EUR-JPY","EUR-CHF"]'::jsonb,
   'free-public',
   'European Central Bank Statistical Data Warehouse (SDW) Data API. Daily euro foreign-exchange reference rates back to 1999-01-04. Owns the authority chain for USD/EUR (replaces Frankfurter proxy). Series key D.<CCY>.EUR.SP00.A; format=csvdata.'
  ),
  ('rba', 'primary', TRUE,
   'https://www.rba.gov.au/statistics',
   'Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0)',
   0.5,
   '["USD-AUD"]'::jsonb,
   'free-public',
   'Reserve Bank of Australia F11 series, daily AUD/USD fixing (1969→). Akamai blocks cloud IPs; runner lives on jarvis (/home/kiwi/bin/run-rba-backfill.sh) and streams CSV before publishing to OR PROD via the pooler.'
  ),
  ('snb', 'primary', TRUE,
   'https://data.snb.ch',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.3,
   '["USD-CHF","EUR-CHF","GBP-CHF","JPY-CHF"]'::jsonb,
   'free-public',
   'Swiss National Bank daily reference rates (1980→). Primary path: SDMX CSV from data.snb.ch/api/cube/<code>/data/csv/en. Fallback: Playwright DOM extraction on the SPA when the CSV endpoint 404s.'
  ),
  ('boj', 'primary', TRUE,
   'https://www.stat-search.boj.or.jp',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.3,
   '["USD-JPY","EUR-JPY","GBP-JPY"]'::jsonb,
   'free-public',
   'Bank of Japan 5pm-Tokyo fixings via the SSI famecgi2 CSV download. Legacy Shift_JIS encoding decoded with TextDecoder; ~1973→. Unit string varies by series ("Yen per US$" vs "U.S. dollar per 100 yen"); plug-in normalises both directions.'
  )
ON CONFLICT (name) DO NOTHING;

-- Re-tag existing Frankfurter-sourced USD/EUR rows to source_authority='ECB'.
--
-- Frankfurter is an ECB proxy. Rows imported before the ECB plug-in were
-- tagged source_authority='ORBI' by default. They are actually ECB-
-- authoritative; this retag completes the authority chain. We scope the
-- update tightly so we never touch a row whose data didn't come from ECB:
--   - product = 'ORBI-D' (daily)            -- not the new 'ORBI-D-authority'
--   - tier   = 'B-single'                   -- single-provider rows only
--   - provider_count = 1                    -- belt-and-braces
--   - granularity = '1d'                    -- daily only
--   - source_currency = 'USD' AND target_currency = 'EUR'
--
-- If a row already has source_authority='ECB' (because the ECB plug-in
-- backfilled it first), the ON CONFLICT unique constraint on the 6-tuple
-- (..., source_authority) means this UPDATE would violate uniqueness. We
-- guard against that with a NOT EXISTS subquery — only retag rows that
-- don't already have an ECB sibling.
--
-- This is a one-off cleanup; subsequent ECB backfills land directly with
-- source_authority='ECB' at write time.

UPDATE exchange_rates AS r
SET source_authority = 'ECB'
WHERE r.source_currency = 'USD'
  AND r.target_currency = 'EUR'
  AND r.granularity     = '1d'
  AND r.product         = 'ORBI-D'
  AND r.tier            = 'B-single'
  AND r.provider_count  = 1
  AND r.source_authority = 'ORBI'
  AND NOT EXISTS (
    SELECT 1 FROM exchange_rates s
    WHERE s.source_currency = r.source_currency
      AND s.target_currency = r.target_currency
      AND s.bucket_ts       = r.bucket_ts
      AND s.granularity     = r.granularity
      AND s.product         = r.product
      AND s.source_authority = 'ECB'
  );
