-- ORBI migration 016 — register Banco Central de Chile (BCCH) source.
--
-- Ships USD/CLP daily "Dólar Observado" (BCCH series F073.TCO.PRE.Z.D)
-- transported through mindicador.cl, a free public Chilean civic-data
-- proxy. BCCH's own Siete REST API requires registered authentication,
-- which violates ORBI's silent-posture rule (no permission emails, no
-- central-bank fingerprint). mindicador.cl publishes the same official
-- series as no-auth JSON.
--
-- Authority tagging follows the established ECB-via-Frankfurter
-- precedent (PR #146): rows land with `source_authority = 'BCCH'` per
-- data origin; transport (`mindicador.cl`) is recorded only in this
-- providers row, not on the observation.
--
-- Shipped ACTIVE; mindicador.cl is open public data with a stable JSON
-- contract since 2013. Founder approved Option 1 in
-- orbi/scripts/central-banks/DEFERRED_SOURCES.md on 2026-05-27.

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bcch', 'primary', TRUE,
   'https://mindicador.cl/api/dolar',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.5,
   '["USD-CLP"]'::jsonb,
   'free-public',
   'Banco Central de Chile USD/CLP daily Dólar Observado (series F073.TCO.PRE.Z.D), sourced via mindicador.cl (free public proxy, no auth, no anti-scraping, no documented commercial restriction). Authority signature BCCH per data origin; transport mindicador per silent-posture compatibility (BCCH Siete REST requires registered auth). Coverage 2003-01-02 onward, business days only.'
  )
ON CONFLICT (name) DO NOTHING;

-- Extend the exchange_rates.source_authority CHECK to include 'BCCH'.
-- Migration 006 introduced the multi-authority column with a fixed
-- whitelist; new authorities must be added via DROP/ADD CONSTRAINT.
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
    'BLOCKCHAIN_COM'::text
  ]));
