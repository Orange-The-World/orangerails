-- ORBI 026 — Precious metals as a separate table.
--
-- Why separate (vs. extending exchange_rates):
--   1. Hard-money domain: keep currency data clean of metal-specific edge cases
--      (LBMA fix vs spot, troy ounce vs gram, bid/ask spreads).
--   2. Different source mix: LBMA, COMEX, Kitco, Kraken XAU/USD, FRED GOLDAMGBD228NLBM,
--      Bank of Canada gold reserves. Composite reconciler may evolve separately.
--   3. Different cadence: gold has a once-a-day "London fix" plus continuous spot;
--      currencies don't.
--   4. Future-proof: bond yields and equity indexes will get their own tables too.
--
-- Schema mirrors exchange_rates closely so loaders / reconciler / inventory scripts
-- can be parameterized by table name with minimal divergence.

BEGIN;

CREATE TABLE IF NOT EXISTS precious_metals_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The metal symbol per ISO 4217 currency-style codes:
  --   XAU = gold, XAG = silver, XPT = platinum, XPD = palladium, XRH = rhodium
  source_metal        text NOT NULL,
  -- Unit being quoted in (USD, EUR, GBP, JPY, BTC, etc.)
  target_currency     text NOT NULL,

  bucket_ts           timestamptz NOT NULL,
  granularity         text NOT NULL,
  product             text NOT NULL,

  -- Always per troy ounce unless weight_unit says otherwise.
  weight_unit         text NOT NULL DEFAULT 'troy_oz',
  rate                numeric NOT NULL,

  -- Tier semantics from exchange_rates:
  --   A          = multi-source median (≥3 independent venues)
  --   B          = 2-source median
  --   B-single   = single source observation
  --   C-composite= derived via cross-rate
  --   stable     = fix value (e.g. LBMA AM/PM Fix)
  tier                text NOT NULL,
  composite           boolean NOT NULL DEFAULT false,
  composite_via       text,
  provider_count      integer NOT NULL DEFAULT 1,

  -- Status: CONFIRMED | PENDING | CORRECTED (e.g. LBMA fix revisions)
  status              text NOT NULL DEFAULT 'CONFIRMED',
  superseded_by_id    uuid,

  fetched_at          timestamptz NOT NULL DEFAULT now(),
  computed_at         timestamptz NOT NULL DEFAULT now(),

  -- Provenance:
  --   forward-fill       = live ingestion every N minutes
  --   historical-backfill= deep history from vendor API
  --   reconciler-upgrade = retroactive tier promotion
  --   composite-replay   = derived via cross-rate (e.g. XAU/EUR via XAU/USD * USD/EUR)
  --   on-demand-resolve  = client-triggered fetch
  --   lbma-fix           = official London Bullion Market Association price fix
  provenance          text NOT NULL,

  -- Source authority (mirrors exchange_rates pattern):
  --   ORBI       = composite/median
  --   LBMA       = London Bullion Market Association
  --   COMEX      = CME Group COMEX futures
  --   KITCO      = Kitco spot aggregator
  --   KRAKEN     = Kraken XAU/XAG pairs
  --   FRED       = St. Louis Fed (republishes LBMA fix as series)
  --   BCB, BOC, BANXICO etc. = central bank reserve valuations
  source_authority    text NOT NULL,

  CONSTRAINT precious_metals_rates_source_metal_check
    CHECK (source_metal = ANY (ARRAY['XAU','XAG','XPT','XPD','XRH'])),

  CONSTRAINT precious_metals_rates_granularity_check
    CHECK (granularity = ANY (ARRAY['1m','1h','1d','fix'])),

  CONSTRAINT precious_metals_rates_product_check
    CHECK (product = ANY (ARRAY['ORBI-M','ORBI-H','ORBI-D','ORBI-FIX'])),

  CONSTRAINT precious_metals_rates_tier_check
    CHECK (tier = ANY (ARRAY['A','B','B-single','C-composite','stable'])),

  CONSTRAINT precious_metals_rates_status_check
    CHECK (status = ANY (ARRAY['CONFIRMED','PENDING','CORRECTED'])),

  CONSTRAINT precious_metals_rates_provenance_check
    CHECK (provenance = ANY (ARRAY[
      'forward-fill','historical-backfill','reconciler-upgrade',
      'composite-replay','on-demand-resolve','lbma-fix'
    ])),

  CONSTRAINT precious_metals_rates_source_authority_check
    CHECK (source_authority = ANY (ARRAY[
      'ORBI','LBMA','COMEX','KITCO','KRAKEN','FRED',
      'BCB','BOC','BANXICO','ECB','BOE','SNB','RBA','RBI','BANREP','SARB','BCRP','BCCH','BNM','BSP','BI'
    ])),

  CONSTRAINT precious_metals_rates_composite_consistency
    CHECK ((composite = false AND composite_via IS NULL)
        OR (composite = true  AND composite_via IS NOT NULL)),

  CONSTRAINT precious_metals_rates_rate_positive CHECK (rate > 0),

  CONSTRAINT precious_metals_rates_weight_unit_check
    CHECK (weight_unit = ANY (ARRAY['troy_oz','gram','kg']))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_metals_rates_pair_bucket_authority
  ON precious_metals_rates (source_metal, target_currency, bucket_ts, granularity, product, source_authority);

CREATE INDEX IF NOT EXISTS idx_metals_rates_lookup
  ON precious_metals_rates (source_metal, target_currency, granularity, product, bucket_ts DESC);

CREATE INDEX IF NOT EXISTS idx_metals_rates_authority
  ON precious_metals_rates (source_authority);

-- Resolutions audit table (mirrors exchange_rate_resolutions)
CREATE TABLE IF NOT EXISTS precious_metals_resolutions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_id               uuid NOT NULL REFERENCES precious_metals_rates(id) ON DELETE CASCADE,
  provider_responses    jsonb NOT NULL,
  providers_succeeded   text[] NOT NULL,
  providers_failed      jsonb,
  outliers_discarded    jsonb,
  median_calculation    text,
  fetched_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metals_resolutions_rate_id
  ON precious_metals_resolutions (rate_id);

-- RLS (public-read, same posture as exchange_rates)
ALTER TABLE precious_metals_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE precious_metals_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_metals_rates ON precious_metals_rates;
CREATE POLICY public_read_metals_rates ON precious_metals_rates
  FOR SELECT TO anon, authenticated USING (status = 'CONFIRMED');

DROP POLICY IF EXISTS public_read_metals_resolutions ON precious_metals_resolutions;
CREATE POLICY public_read_metals_resolutions ON precious_metals_resolutions
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE precious_metals_rates IS
'Hard-money table: gold, silver, platinum, palladium, rhodium prices in any target unit. Mirrors exchange_rates shape so loaders are portable. Deliberately separate to prevent currency-side bugs from contaminating metals data.';

COMMENT ON COLUMN precious_metals_rates.source_metal IS
'ISO 4217 currency-style codes: XAU (gold), XAG (silver), XPT (platinum), XPD (palladium), XRH (rhodium).';

COMMENT ON COLUMN precious_metals_rates.weight_unit IS
'Quote unit. Default troy_oz. Conversion to gram/kg is the consumer''s responsibility.';

COMMIT;

-- Track in schema_migrations
INSERT INTO public.schema_migrations (version, applied_at, source)
VALUES ('026_precious_metals', now(), 'audit') ON CONFLICT DO NOTHING;
