-- ORBI migration 017 — register Bangko Sentral ng Pilipinas (BSP) source.
--
-- Ships USD/PHP daily Philippine-peso reference rate published by BSP at
--   https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx
-- The workbook covers 1978 → present (daily/monthly/annual sheets); ORBI
-- consumes the "daily" sheet and lands rows with source_authority = 'BSP'.
--
-- Sovereign authority: file is published from BSP's own sharepoint path
-- ("LEID/IND/Exchange Rate/01 Daily/01 Peso-Dollar/") and referenced from
-- the BSP ExchangeRate.aspx landing page. No auth, no key, no Akamai
-- fingerprint — silent-friendly under ORBI's Hybrid Asymmetric Strategy.
--
-- Shipped ACTIVE because the URL has been stable for years and the XLSX
-- contract (sheet names, column layout) is plain Excel. Founder still
-- gates the first live backfill via the orchestrator dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'BSP'.
--
-- The constraint was originally defined in migration 006 as a closed list
-- of authority codes (ORBI, ECB, BANXICO, BCB, BOC, FED, BOE, RBA, SNB,
-- BOJ, BLOCKCHAIN_COM). Adding a new authority requires dropping and
-- re-creating the CHECK; rows already in the table are unaffected.
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
    'BSP'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register BSP provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bsp', 'primary', TRUE,
   'https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.2,
   '["USD-PHP"]'::jsonb,
   'free-public',
   'Bangko Sentral ng Pilipinas daily Philippine-peso reference rate, published as a single XLSX workbook (sheets: monthly, annual, daily). Daily sheet covers 1978-01-03 → present. No-auth, no-key download from the public BSP statistics site; XLSX parsed in-process via a minimal node:zlib reader (no external dependency, matching the convention of every other central-bank plug-in in this folder).'
  )
ON CONFLICT (name) DO NOTHING;
