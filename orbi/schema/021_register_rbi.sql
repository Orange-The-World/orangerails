-- ORBI migration 021 — register Reserve Bank of India (RBI) source.
--
-- Ships USD/INR daily Reference Rate published by RBI at
--   https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx
-- Since 2018-07-10 the underlying rate is computed by Financial Benchmarks
-- India Limited (FBIL) and published on the RBI site as the official
-- "Reference Rate" (Source: FBIL). ORBI consumes the RBI archive page —
-- the sovereign-authority surface — and lands rows with
-- source_authority = 'RBI'.
--
-- Sovereign authority: rate is published by the central bank's own
-- website. Free, no auth, no API key. The archive form is an ASP.NET
-- WebForms page protected by an ASP.NET_SessionId cookie + a
-- __VIEWSTATE / __EVENTVALIDATION token pair; the scraper performs a
-- GET to harvest the tokens, then a single POST per year-chunk to
-- retrieve up to 1000 daily rows. No Akamai fingerprint observed from
-- bb-support during 2026-05-27 validation — silent-friendly under
-- ORBI's Hybrid Asymmetric Strategy.
--
-- History note: the archive only returns observations from 2022-04-04
-- onward (FBIL transition + RBI archive re-architecture). The
-- 2021-01-01 → 2022-04-03 window is intentionally a coverage gap;
-- documented in DEFERRED_SOURCES.md and the source-file header.
--
-- Shipped ACTIVE because the URL + form contract has been stable since
-- the FBIL transition. Founder still gates the first live backfill via
-- the orchestrator dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'RBI'.
--
-- The constraint was originally defined in migration 006 as a closed list
-- of authority codes (ORBI, ECB, BANXICO, BCB, BOC, FED, BOE, RBA, SNB,
-- BOJ, BLOCKCHAIN_COM); migration 016 added BCCH; migration 017 added
-- BSP; migration 018 added BNM. Adding a new authority requires dropping
-- and re-creating the CHECK; rows already in the table are unaffected.
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
    'SARB'::text,
    'BCRP'::text,
    'RBI'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register RBI provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('rbi', 'primary', TRUE,
   'https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.2,
   '["USD-INR"]'::jsonb,
   'free-public',
   'Reserve Bank of India daily USD/INR Reference Rate (published as Source: FBIL since 2018-07). Free, no-auth ASP.NET WebForms archive page; scraper harvests ASP.NET_SessionId + __VIEWSTATE / __EVENTVALIDATION tokens via a GET then POSTs once per year-chunk. Server caps each response at ~995 rows; orchestrator chunks by calendar year. Archive coverage begins 2022-04-04; earlier rates are not exposed by this endpoint.'
  )
ON CONFLICT (name) DO NOTHING;
