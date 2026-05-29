-- ORBI 027 — Inflation as a separate table.
--
-- Inflation is fundamentally NOT an exchange rate:
--   - Period-indexed (monthly, quarterly), not minute-tick
--   - One official authority per country (no median across sources)
--   - Revisions are routine (initial → revised → final)
--   - Many flavors per country (headline CPI, core, PCE, PPI, HICP, GDP deflator)
--   - Base years differ across sources; raw index needs context
--
-- Schema captures both the raw index AND the headline derived rates (YoY, MoM)
-- so consumers don't need to recompute. Revisions are first-class via
-- revision_number + superseded_by_id.

BEGIN;

CREATE TABLE IF NOT EXISTS inflation_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ISO 3166-1 alpha-2, or special codes:
  --   EUR = euro-zone aggregate
  --   G7  = G7 aggregate (OECD)
  --   OECD = OECD aggregate
  country             text NOT NULL,

  -- Optional sub-region. Most rows leave this null.
  --   For US: 'urban' (CPI-U), 'wage-earners' (CPI-W), 'northeast', 'midwest', etc.
  --   For EUR: 'core' euro area vs 'euro area 19', 'euro area 20'
  region              text,

  -- The measure being reported.
  --   CPI            = headline consumer price index
  --   CPI-core       = excluding food and energy
  --   PCE            = personal consumption expenditures (US-specific, Fed's preferred)
  --   PCE-core       = PCE excluding food and energy
  --   PPI            = producer price index
  --   PPI-core       = PPI excluding food and energy
  --   HICP           = harmonised index of consumer prices (EU)
  --   HICP-core      = HICP excluding energy and unprocessed food
  --   GDP-deflator   = implicit price deflator from GDP
  --   import-price   = import price index
  --   export-price   = export price index
  index_kind          text NOT NULL,

  -- The period the measurement describes.
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  -- Human-friendly label: '2026-04', '2026-Q1', '2026'
  period_label        text NOT NULL,

  -- When the authority RELEASED this number. Often 2-6 weeks after period_end.
  release_date        date,

  -- The raw index value as published. Meaning depends on base_year.
  value               numeric NOT NULL,
  -- The base year for the index (when value = 100 by convention). Some series
  -- use period averages instead of a single year — see source_series_id docs.
  base_year           integer,

  -- Denormalised derived headline rates. Source may publish these directly OR
  -- they're computed by us from successive period values. populated_by tells us.
  yoy_pct             numeric,  -- year-over-year % change
  mom_pct             numeric,  -- month-over-month % change (or qoq for quarterly)
  populated_by        text NOT NULL DEFAULT 'source',  -- 'source' | 'derived'

  -- Revision tracking. A given (country, region, index_kind, period_start) can
  -- have multiple rows over time — first the initial release, then revisions.
  -- The newest one points back via superseded_by_id chain.
  revision_number     integer NOT NULL DEFAULT 0,  -- 0 = initial, 1 = first revised, ...
  superseded_by_id    uuid REFERENCES inflation_rates(id),

  -- Confidence:
  --   PROVISIONAL = initial release
  --   REVISED     = subsequent revision
  --   FINAL       = no further revision expected
  --   ESTIMATE    = nowcast / preliminary estimate (e.g. flash HICP)
  status              text NOT NULL DEFAULT 'PROVISIONAL',

  source_authority    text NOT NULL,
  source_url          text,
  -- Vendor's series ID. e.g. 'CPIAUCSL' for FRED's US CPI-U, 'M0014' for IBGE
  source_series_id    text,

  -- Provenance:
  --   initial-release   = first publication of this period
  --   revised           = re-published with updated number
  --   final             = no more revisions expected
  --   derived           = computed from another series (e.g. yoy from raw index)
  --   historical-backfill = bulk import from vendor archive
  --   forward-fill      = scheduled new-release watcher
  provenance          text NOT NULL,

  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inflation_rates_index_kind_check CHECK (
    index_kind = ANY (ARRAY[
      'CPI','CPI-core','PCE','PCE-core','PPI','PPI-core',
      'HICP','HICP-core','GDP-deflator','import-price','export-price'
    ])
  ),

  CONSTRAINT inflation_rates_status_check CHECK (
    status = ANY (ARRAY['PROVISIONAL','REVISED','FINAL','ESTIMATE'])
  ),

  CONSTRAINT inflation_rates_populated_by_check CHECK (
    populated_by = ANY (ARRAY['source','derived'])
  ),

  CONSTRAINT inflation_rates_provenance_check CHECK (
    provenance = ANY (ARRAY[
      'initial-release','revised','final','derived','historical-backfill','forward-fill'
    ])
  ),

  CONSTRAINT inflation_rates_source_authority_check CHECK (
    source_authority = ANY (ARRAY[
      'BLS','BEA','FRED','EUROSTAT','ECB','OECD','IMF','WORLD_BANK',
      'IBGE','INDEC','INE-CL','DANE-CO','INEI-PE','STATS_SA','STATS_RBI',
      'ONS-GB','DESTATIS-DE','INSEE-FR','ISTAT-IT','INE-ES',
      'STATS_NZ','ABS-AU','STATS_CA','STATS_JP',
      'STATS_KR','STATS_TR','STATS_PH','STATS_TH','STATS_MX-INEGI',
      'STATS_ID','STATS_MY','STATS_IL','CZSO-CZ','GUS-PL','SCB-SE','SSB-NO','DST-DK',
      'ORBI'
    ])
  ),

  CONSTRAINT inflation_rates_period_check CHECK (period_end >= period_start),
  CONSTRAINT inflation_rates_value_positive CHECK (value > 0)
);

-- Unique by composite key including revision_number so each release is its own row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inflation_rates_key
  ON inflation_rates (
    country,
    coalesce(region, ''),
    index_kind,
    period_start,
    revision_number,
    source_authority
  );

CREATE INDEX IF NOT EXISTS idx_inflation_rates_lookup
  ON inflation_rates (country, index_kind, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_inflation_rates_release
  ON inflation_rates (release_date DESC);

CREATE INDEX IF NOT EXISTS idx_inflation_rates_authority
  ON inflation_rates (source_authority);

-- Resolutions / audit log mirror.
CREATE TABLE IF NOT EXISTS inflation_resolutions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_id             uuid NOT NULL REFERENCES inflation_rates(id) ON DELETE CASCADE,
  raw_response        jsonb,
  derivation_notes    text,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inflation_resolutions_rate_id
  ON inflation_resolutions (rate_id);

ALTER TABLE inflation_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE inflation_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_inflation_rates ON inflation_rates;
CREATE POLICY public_read_inflation_rates ON inflation_rates
  FOR SELECT TO anon, authenticated
  USING (status IN ('REVISED','FINAL','ESTIMATE'));

DROP POLICY IF EXISTS public_read_inflation_resolutions ON inflation_resolutions;
CREATE POLICY public_read_inflation_resolutions ON inflation_resolutions
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE inflation_rates IS
'Inflation series per country / region / index kind / period. First-class revision support — every release version kept; current row has superseded_by_id IS NULL.';

COMMENT ON COLUMN inflation_rates.value IS
'Raw index value as published. Meaning depends on base_year and source_series_id. Use yoy_pct / mom_pct for cross-country comparison.';

COMMENT ON COLUMN inflation_rates.populated_by IS
'source = yoy/mom published directly by the authority. derived = computed by ORBI from successive raw values.';

COMMIT;

INSERT INTO public.schema_migrations (version, applied_at, source)
VALUES ('027_inflation', now(), 'audit') ON CONFLICT DO NOTHING;
