-- ORBI migration 022 — register Banco de la República (BANREP) source.
--
-- Ships USD/COP daily TRM (Tasa Representativa del Mercado), Colombia's
-- official daily reference rate. Authority: BANREP / Superintendencia
-- Financiera de Colombia (which calculates and certifies the TRM under
-- Resolución 8 de 2000 of the BANREP Junta Directiva). Transport:
-- datos.gov.co (Colombia's MinTIC-run national open data portal),
-- Socrata SODA2 dataset 32sa-8pi3.
--
-- Why a proxy: BANREP's own site (banrep.gov.co) is fronted by Radware
-- Bot Manager and returns a bot-block stub on every server-side fetch
-- regardless of UA (same Akamai-style pattern that blocked RBA in Phase
-- D.2). SuperFinanciera's portal exposes only an HTML query form, no
-- public JSON/CSV. Datos Abiertos Colombia republishes the SuperFin-
-- attributed series as a no-auth, no-key, CC BY-SA 4.0 JSON feed with
-- daily coverage 1991-12-02 → present.
--
-- Authority tagging follows the ECB-via-Frankfurter and BCCH-via-
-- mindicador.cl precedents (PRs #146, #165): rows land with
-- `source_authority = 'BANREP'` per data origin; transport
-- (`datos.gov.co`) is recorded only on the providers row, not on the
-- observation.
--
-- Shipped ACTIVE — datos.gov.co is the official Colombian open data
-- platform with a stable Socrata API contract since 2017, license is
-- CC BY-SA 4.0, no anti-scraping, no rate limit issues at our volume.
-- Founder still gates the first live backfill via the orchestrator
-- dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'BANREP'.
--
-- The constraint was originally defined in migration 006 as a closed
-- list. Migrations 016 (BCCH) and 017 (BSP) already added their codes
-- via DROP/ADD CONSTRAINT; we repeat the full whitelist here so this
-- migration is idempotent and self-contained regardless of which prior
-- migrations have run.
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
    'BANREP'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register BANREP provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('banrep', 'primary', TRUE,
   'https://www.datos.gov.co/resource/32sa-8pi3.json',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.5,
   '["USD-COP"]'::jsonb,
   'free-public',
   'Banco de la República (BANREP) USD/COP daily TRM (Tasa Representativa del Mercado), sourced via datos.gov.co (Colombia''s national open data portal, MinTIC). Socrata SODA2 dataset 32sa-8pi3, attribution Superintendencia Financiera de Colombia, license CC BY-SA 4.0, provenance OFFICIAL. Authority signature BANREP per data origin; transport datos.gov.co per silent-posture compatibility (banrep.gov.co is fronted by Radware Bot Manager). Coverage 1991-12-02 onward, business days with explicit vigenciadesde/vigenciahasta intervals that ORBI expands into a full daily series.'
  )
ON CONFLICT (name) DO NOTHING;
