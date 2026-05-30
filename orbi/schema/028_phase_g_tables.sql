-- ORBI 028 — Phase G data tables.
--
-- Four new tables for the Phase G index publication catalog:
--   wages                    — country/region/measure period series
--   commodity_prices         — item prices per country/period
--   monetary_aggregates      — M0/M1/M2/M3 per country/period
--   tech_productivity_curves — Wright's law / Moore's law performance data
--
-- All four follow the same pattern as inflation_rates: period-indexed,
-- revision-aware where applicable, source_authority tracked, RLS public-read
-- for non-provisional rows, audit-ready via inserted_at + source_url +
-- source_series_id.

BEGIN;

-- ── wages ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country             text NOT NULL,
  region              text,
  -- The wage measure:
  --   median_hourly         = median hourly wage
  --   mean_hourly           = mean / average hourly wage
  --   minimum_hourly        = legal minimum wage (hourly equivalent)
  --   median_weekly         = median weekly wage
  --   median_annual         = median annual wage
  --   real_median_hourly    = inflation-adjusted to a base year
  measure             text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_label        text NOT NULL,
  release_date        date,
  value               numeric NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',
  -- For real_* measures only
  base_year           integer,

  source_authority    text NOT NULL,
  source_url          text,
  source_series_id    text,
  provenance          text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wages_measure_check CHECK (measure = ANY (ARRAY[
    'median_hourly','mean_hourly','minimum_hourly',
    'median_weekly','mean_weekly','median_annual','mean_annual',
    'real_median_hourly','real_mean_hourly'
  ])),
  CONSTRAINT wages_provenance_check CHECK (provenance = ANY (ARRAY[
    'initial-release','revised','final','historical-backfill','forward-fill','derived'
  ])),
  CONSTRAINT wages_source_authority_check CHECK (source_authority = ANY (ARRAY[
    'BLS','BEA','FRED','EUROSTAT','OECD','ILO','WORLD_BANK','IMF',
    'ONS-GB','DESTATIS-DE','INSEE-FR','IBGE','INEGI-MX','ABS-AU','STATS_CA','STATS_JP',
    'STATS_KR','STATS_SA','STATS_RBI','DANE-CO','INE-CL','INEI-PE','INDEC',
    'ORBI'
  ])),
  CONSTRAINT wages_period_check CHECK (period_end >= period_start),
  CONSTRAINT wages_value_positive CHECK (value > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wages_key
  ON wages (country, coalesce(region, ''), measure, period_start, source_authority);
CREATE INDEX IF NOT EXISTS idx_wages_lookup
  ON wages (country, measure, period_start DESC);

-- ── commodity_prices ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commodity_prices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The item being priced. Canonical names:
  --   bread, eggs, milk, ground_beef, chicken_breast, rice, beans, wheat,
  --   gasoline_regular, gasoline_premium, diesel, natural_gas,
  --   electricity_residential_kwh, electricity_industrial_kwh,
  --   crude_oil_wti, crude_oil_brent,
  --   coffee_arabica, coffee_robusta, sugar, cocoa, tomato, banana,
  --   big_mac (for the Big Mac Index)
  item                text NOT NULL,
  -- Country / region the price covers. NULL = global benchmark.
  country             text,
  region              text,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_label        text NOT NULL,
  release_date        date,
  -- The unit:
  --   per_lb, per_kg, per_gallon, per_litre, per_kwh, per_oz_troy,
  --   per_barrel, per_dozen, per_item, per_metric_ton
  unit                text NOT NULL,
  value               numeric NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',

  source_authority    text NOT NULL,
  source_url          text,
  source_series_id    text,
  provenance          text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT commodity_prices_unit_check CHECK (unit = ANY (ARRAY[
    'per_lb','per_kg','per_metric_ton',
    'per_gallon','per_litre','per_barrel',
    'per_kwh','per_mwh','per_btu',
    'per_oz_troy','per_oz_avoirdupois',
    'per_dozen','per_item','per_hour','per_session'
  ])),
  CONSTRAINT commodity_prices_provenance_check CHECK (provenance = ANY (ARRAY[
    'initial-release','revised','final','historical-backfill','forward-fill','derived'
  ])),
  CONSTRAINT commodity_prices_source_authority_check CHECK (source_authority = ANY (ARRAY[
    'BLS','FRED','EIA','EUROSTAT','OECD','FAO','FAOSTAT','ICO','ECONOMIST',
    'WORLD_BANK','IMF','USDA','OPEC',
    'ORBI'
  ])),
  CONSTRAINT commodity_prices_period_check CHECK (period_end >= period_start),
  CONSTRAINT commodity_prices_value_positive CHECK (value > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commodity_prices_key
  ON commodity_prices (item, coalesce(country, 'GLOBAL'), coalesce(region, ''),
                       period_start, unit, source_authority);
CREATE INDEX IF NOT EXISTS idx_commodity_prices_lookup
  ON commodity_prices (item, country, period_start DESC);

-- ── monetary_aggregates ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monetary_aggregates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country             text NOT NULL,
  -- The aggregate:
  --   M0  = monetary base (physical currency + bank reserves)
  --   M1  = M0 + demand deposits
  --   M2  = M1 + savings + money-market + small time deposits
  --   M3  = M2 + large time deposits + institutional money funds
  --   MZM = money zero maturity
  --   FED_LIABILITIES = total Fed balance-sheet liabilities (US only)
  aggregate           text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_label        text NOT NULL,
  release_date        date,
  value               numeric NOT NULL,
  -- Always in the country's own currency.
  currency            text NOT NULL,
  -- Whether the value is seasonally adjusted.
  seasonally_adjusted boolean NOT NULL DEFAULT true,

  source_authority    text NOT NULL,
  source_url          text,
  source_series_id    text,
  provenance          text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT monetary_aggregates_aggregate_check CHECK (aggregate = ANY (ARRAY[
    'M0','M1','M2','M3','MZM','FED_LIABILITIES','ECB_BALANCE_SHEET','BOJ_BALANCE_SHEET'
  ])),
  CONSTRAINT monetary_aggregates_provenance_check CHECK (provenance = ANY (ARRAY[
    'initial-release','revised','final','historical-backfill','forward-fill','derived'
  ])),
  CONSTRAINT monetary_aggregates_source_authority_check CHECK (source_authority = ANY (ARRAY[
    'FRED','FED','ECB','BOJ','BOE','BOC','RBA','SNB','BANXICO','BCB','RBI',
    'OECD','IMF','WORLD_BANK',
    'ORBI'
  ])),
  CONSTRAINT monetary_aggregates_period_check CHECK (period_end >= period_start),
  CONSTRAINT monetary_aggregates_value_positive CHECK (value > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_monetary_aggregates_key
  ON monetary_aggregates (country, aggregate, period_start, source_authority);
CREATE INDEX IF NOT EXISTS idx_monetary_aggregates_lookup
  ON monetary_aggregates (country, aggregate, period_start DESC);

-- ── tech_productivity_curves ────────────────────────────────────────────────
-- Wright's law / experience-curve data for the Tech Deflation Index.
-- Each row: one observation of a technology's performance metric at a point
-- in time. Slope of the log-log fit gives the learning rate.
CREATE TABLE IF NOT EXISTS tech_productivity_curves (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The technology:
  --   solar_module, lithium_battery, cpu_logic, ram_bit, hdd_byte,
  --   ssd_byte, led_lumen, gnu_genome, broadband_mbps_per_dollar,
  --   ev_battery_pack, wind_turbine_capacity, satellite_launch_kg
  item                text NOT NULL,
  -- The metric:
  --   usd_per_watt, usd_per_kwh, transistors_per_chip, lumens_per_dollar,
  --   bytes_per_dollar, megabits_per_sec_per_dollar, usd_per_genome,
  --   usd_per_kg_to_orbit
  metric              text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  value               numeric NOT NULL,
  unit                text NOT NULL,
  currency            text DEFAULT 'USD',

  -- Cumulative production proxy (for Wright's law fit):
  -- Wright's law says price decays as cumulative production doubles.
  -- If known, store cumulative_production at this point.
  cumulative_production    numeric,
  cumulative_production_unit text,

  source_authority    text NOT NULL,
  source_url          text,
  notes               text,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tech_productivity_curves_source_authority_check CHECK (source_authority = ANY (ARRAY[
    'BLS','FRED','EIA','IEA','NREL','BNEF',
    'OUR_WORLD_IN_DATA','RITCHIE-ROSER','IRENA',
    'INTC_HISTORICAL','OPENAI_COST_PAPERS','SEMICONDUCTOR_INDUSTRY_ASSOC',
    'ORBI_RESEARCH'
  ])),
  CONSTRAINT tech_productivity_curves_value_positive CHECK (value > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tech_productivity_curves_key
  ON tech_productivity_curves (item, metric, period_start, source_authority);
CREATE INDEX IF NOT EXISTS idx_tech_productivity_curves_lookup
  ON tech_productivity_curves (item, metric, period_start DESC);

-- ── RLS public-read (consistent posture with other ORBI tables) ──────────────
ALTER TABLE wages ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodity_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetary_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tech_productivity_curves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_wages ON wages;
CREATE POLICY public_read_wages ON wages
  FOR SELECT TO anon, authenticated USING (provenance IN ('revised','final','historical-backfill'));

DROP POLICY IF EXISTS public_read_commodity_prices ON commodity_prices;
CREATE POLICY public_read_commodity_prices ON commodity_prices
  FOR SELECT TO anon, authenticated USING (provenance IN ('revised','final','historical-backfill','forward-fill'));

DROP POLICY IF EXISTS public_read_monetary_aggregates ON monetary_aggregates;
CREATE POLICY public_read_monetary_aggregates ON monetary_aggregates
  FOR SELECT TO anon, authenticated USING (provenance IN ('revised','final','historical-backfill','forward-fill'));

DROP POLICY IF EXISTS public_read_tech_productivity_curves ON tech_productivity_curves;
CREATE POLICY public_read_tech_productivity_curves ON tech_productivity_curves
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE wages IS
'Period-indexed wage series per country / region / measure. Backs the Sat Wage, Hours of Work for X, and Working for the Bills indexes.';

COMMENT ON TABLE commodity_prices IS
'Period prices of physical commodities and consumer items (bread, eggs, gasoline, kWh, gold ounce, etc.) per country/region. Backs Hours of Work for X, Working for the Bills, Spend Smart Gauge.';

COMMENT ON TABLE monetary_aggregates IS
'M0/M1/M2/M3 and central bank balance sheets per country. Backs the $1 Cone, Tech Deflation Index (M2 overlay), and Hardness Ratio.';

COMMENT ON TABLE tech_productivity_curves IS
'Wright''s law / Moore''s law observations: technology performance metrics over time. Backs the Tech Deflation Index and Should-Be Calculator.';

COMMIT;

INSERT INTO public.schema_migrations (version, applied_at, source)
VALUES ('028_phase_g_tables', now(), 'roadmap') ON CONFLICT DO NOTHING;
