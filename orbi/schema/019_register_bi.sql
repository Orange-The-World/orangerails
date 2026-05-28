-- ORBI migration 019 — register Bank Indonesia (BI) source.
--
-- Ships USD/IDR daily JISDOR (Jakarta Interbank Spot Dollar Offered Rate)
-- reference rate published by Bank Indonesia at
--   https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx
-- JISDOR is BI's official daily peg used for Indonesian-tax and IFRS FX
-- conversion. Calculated each business day at ~10:00 WIB (UTC+7) from
-- volume-weighted spot interbank quotes; published on a SharePoint-hosted
-- ASP.NET WebForms page with a date-range filter. ORBI consumes the
-- "Cari" (Search) postback path which returns plaintext HTML and chunks
-- the backfill into per-month windows (the BI backend severs the
-- connection for larger windows from a single IP).
--
-- Sovereign authority: page is served from www.bi.go.id (Bank Indonesia's
-- own domain, valid GlobalSign cert with O=Bank Indonesia). No auth, no
-- API key, no Akamai fingerprint — silent-friendly under ORBI's Hybrid
-- Asymmetric Strategy.
--
-- Shipped ACTIVE because the postback path is the same surface that BI's
-- own site uses to render the table; behavior has been stable since the
-- SharePoint migration (the page's earliest cached entries on archive.org
-- date to 2018 with the same form structure). Founder still gates the
-- first live backfill via the orchestrator dry-run pattern.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'BI'.
--
-- The CHECK was last extended in prod by migration 014_register_bcrp.sql
-- (sibling agent landed BCRP rows ahead of this branch on 2026-05-28).
-- Adding a new authority requires dropping and re-creating the CHECK;
-- rows already in the table are unaffected. The new allowlist mirrors
-- the current prod list (read live with `pg_get_constraintdef` on
-- 2026-05-28) plus 'BNM' (already on dev via #169) and 'BI'. Parallel
-- sibling branches still in flight (RBI / SARB / BANREP) each emit
-- their own DROP/ADD with the union of declared authorities, so apply
-- order resolves at merge time.
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
    'RBI'::text,
    'BI'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register BI provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bi', 'primary', TRUE,
   'https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.1,
   '["USD-IDR"]'::jsonb,
   'free-public',
   'Bank Indonesia daily JISDOR (Jakarta Interbank Spot Dollar Offered Rate). Sourced via the ASP.NET WebForms postback at the JISDOR page; rows are scraped from the HTML table returned by the "Cari" (Search) submission. Backfill chunks the date window per calendar month — the BI SharePoint backend severs the connection for larger windows from a single IP. No-auth, no-key, no Akamai fingerprint.'
  )
ON CONFLICT (name) DO NOTHING;
