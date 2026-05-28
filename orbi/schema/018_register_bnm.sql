-- ORBI migration 018 — register Bank Negara Malaysia (BNM) source.
--
-- Ships USD/MYR daily Ringgit reference rate published by BNM via the
-- public "Kijang" Open API at
--   https://api.bnm.gov.my/public/exchange-rate/USD/year/{YYYY}/month/{M}
-- ORBI consumes the default (1130) reference session and lands rows
-- with source_authority = 'BNM'.
--
-- Sovereign authority: api.bnm.gov.my is operated directly by BNM as
-- part of their Open API Initiative. No auth, no key, no Akamai
-- fingerprint — silent-friendly under ORBI's Hybrid Asymmetric
-- Strategy. The vendor `Accept: application/vnd.BNM.API.v1+json`
-- header is BNM's documented content-negotiation contract.
--
-- Shipped ACTIVE because the endpoint is stable, free, and the JSON
-- contract is plain. Founder still gates the first live backfill via
-- the orchestrator dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'BNM'.
--
-- The constraint was originally defined in migration 006 as a closed list
-- of authority codes and last extended in migration 017 to add 'BSP'.
-- Adding a new authority requires dropping and re-creating the CHECK;
-- rows already in the table are unaffected.
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
    'BNM'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register BNM provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bnm', 'primary', TRUE,
   'https://api.bnm.gov.my/public/exchange-rate',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   2.0,
   '["USD-MYR"]'::jsonb,
   'free-public',
   'Bank Negara Malaysia daily Ringgit reference rate, published as JSON via the BNM Kijang Open API (Accept: application/vnd.BNM.API.v1+json). USD/MYR pulled per calendar month via /public/exchange-rate/USD/year/{YYYY}/month/{M}. Default 1130 session is the official noon reference accepted by Malaysian tax (LHDN/IRBM). middle_rate is null in 1130 payloads; daily mid is computed as (buying_rate + selling_rate) / 2 — matches the 1200-session middle_rate to <= 1e-4. No-auth, no-key — silent-friendly.'
  )
ON CONFLICT (name) DO NOTHING;
