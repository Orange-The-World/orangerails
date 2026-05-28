-- ORBI migration 020 — register South African Reserve Bank (SARB) source.
--
-- Ships USD/ZAR daily Rand-per-US-Dollar indicative rate published by SARB
-- via the public Web API at
--   https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/
--     GetTimeseriesObservations/EXCX135D/{startDate}/{endDate}
-- The EXCX135D series is described by SARB as: "Weighted average of the
-- banks' daily rates at approximately 10:30 am. Weights are based on the
-- banks' foreign exchange transactions" — the official SARB indicative
-- USD/ZAR daily reference rate. JSON, no auth, no key, no Akamai-style
-- WAF — silent-friendly under ORBI's Hybrid Asymmetric Strategy.
--
-- We already carry USD/ZAR via Frankfurter cross-rate; this plug-in adds
-- the sovereign-authority signature on the same pair, which is more
-- defensible for South African customer audits. The orchestrator's
-- source_authority='SARB' is what differentiates the rows.
--
-- Shipped ACTIVE — the endpoint has been stable for years and the JSON
-- contract is trivial. Founder still gates the first live backfill via
-- the orchestrator's dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'SARB'.
--
-- The constraint was last re-issued in migration 017 (BSP). Adding a new
-- authority requires dropping and re-creating the CHECK; rows already in
-- the table are unaffected. Full allowlist re-asserted below.
-- ----------------------------------------------------------------------------

ALTER TABLE exchange_rates
  DROP CONSTRAINT IF EXISTS exchange_rates_source_authority_check;

ALTER TABLE exchange_rates
  ADD CONSTRAINT exchange_rates_source_authority_check
  CHECK (source_authority = ANY (ARRAY[
    'ORBI'::text,
    'ECB'::text,
    'BANXICO'::text,
    'BCB'::text,
    'BOC'::text,
    'FED'::text,
    'BOE'::text,
    'RBA'::text,
    'SNB'::text,
    'BOJ'::text,
    'BCCH'::text,
    'BLOCKCHAIN_COM'::text,
    'BSP'::text,
    'BNM'::text,
    'BANREP'::text,
    'SARB'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register SARB provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('sarb', 'primary', TRUE,
   'https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.2,
   '["USD-ZAR"]'::jsonb,
   'free-public',
   'South African Reserve Bank daily Rand-per-US-Dollar indicative rate. Series EXCX135D (weighted average of banks daily rates at ~10:30 am, weighted by FX transaction volume) — the official SARB indicative reference. Public Web API, JSON, no auth, no key. Coverage verified 2026-05-27: 2021-01-04 → present (1,348 rows over the 5-year backfill window). SARB disclaimer restricts redistribution; ORBI uses this as an authoritative reference signal (auditor-facing provenance), not for bulk republication — same silent-posture stance applied to RBA.'
  )
ON CONFLICT (name) DO NOTHING;
