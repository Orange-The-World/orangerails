-- ORBI 029 — Historical money prices (millennia-deep, citation-quality).
--
-- A scholarship-grade table for long-arc money history: Roman denarius silver
-- content, medieval gold ducat purchasing power, US dollar vs gold 1792→1971,
-- ancient drachma vs wheat, etc. Different shape from exchange_rates and
-- precious_metals_rates:
--   - Era-grained (year_start / year_end, supporting BC dates as negatives)
--   - Citation-required (every row points to a scholarly source)
--   - Confidence-graded (primary attestation vs scholarly reconstruction)
--   - Low row count (~2000 rows at completion, vs 19M+ in exchange_rates)
--   - High narrative density per row (each is one citation, one historical fact)
--
-- Backs: Empire Currency Decay, Hard Money Throughline, Great Decoupling (older
-- slice), and the long-arc multi-book signature indexes.

BEGIN;

CREATE TABLE IF NOT EXISTS historical_money_prices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The asset being priced. Canonical codes:
  --   gold_oz_troy, silver_oz_troy,
  --   roman_denarius_silver_grams, roman_aureus_gold_grams,
  --   byzantine_solidus_gold_grams,
  --   florentine_florin_gold_grams, venetian_ducat_gold_grams,
  --   spanish_real_silver_grams, spanish_escudo_gold_grams,
  --   french_livre_silver_grams, french_louis_dor_gold_grams,
  --   british_pound_sterling_silver_grams, british_sovereign_gold_grams,
  --   us_dollar_silver_grams, us_dollar_gold_grams,
  --   athenian_drachma_silver_grams, persian_daric_gold_grams,
  --   babylonian_shekel_silver_grams,
  --   wheat_bushel, bread_loaf  (real-value reference assets)
  asset               text NOT NULL,

  -- The currency or reference unit the value is denominated in:
  --   USD, GBP, EUR (modern fiat)
  --   troy_oz_silver, troy_oz_gold (cross-metal ratios)
  --   wheat_bushel, bread_loaf, daily_wage_labourer (real-value units)
  --   denarius, livre, peso, sterling (ancient/medieval cross-rates)
  quote_in            text NOT NULL,

  -- Period this row describes. Supports BC via negative year_start.
  -- Use the same year for both ends if it's a point observation.
  -- Use a range for averaged-over-period values (e.g., a decade or a reign).
  year_start          integer NOT NULL,
  year_end            integer NOT NULL,
  -- Human label: '14 AD', '305-313 (Diocletian reform)', '1717-08-31 (Newton fix)'
  period_label        text NOT NULL,

  -- The value at that period
  value               numeric NOT NULL,
  unit                text NOT NULL,  -- e.g. 'denarii_per_modius', 'shillings_per_oz', 'grams_silver'

  -- Confidence in the value:
  --   primary   = directly attested by a contemporary source (price edict, mint record,
  --               surviving exchange ledger, surviving coin metallurgy)
  --   scholarly = reconstructed by a peer-reviewed economic historian
  --   estimated = best-guess from indirect evidence, range > 50%
  --   nominal   = official fixed price (US gold standard 1834-1971, etc.)
  confidence          text NOT NULL,

  -- Source authority — see allowlist below
  source_authority    text NOT NULL,

  -- Mandatory citation: full bibliographic reference where the value comes from.
  -- For books: 'Crawford 1985, Roman Republican Coinage, vol. II p. 412'
  -- For papers: 'Allen 2001, EHR 54.4, table 3'
  -- For data services: 'Officer & Williamson 2026, Measuring Worth, UK retail price series'
  citation            text NOT NULL,

  -- Who compiled the data point (the historian / project)
  compiler            text,

  -- Geographic + political context: 'Roman Empire (Italy)', 'England',
  -- 'Spanish Habsburg Empire', 'United States', 'Athenian Polis'
  region              text,

  -- Free-form for footnotes, alternate readings, methodology notes
  notes               jsonb,

  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT historical_money_prices_confidence_check CHECK (confidence = ANY (ARRAY[
    'primary','scholarly','estimated','nominal'
  ])),

  CONSTRAINT historical_money_prices_source_authority_check CHECK (source_authority = ANY (ARRAY[
    -- Scholarly compilations
    'MEASURING_WORTH',       -- Officer & Williamson, measuringworth.com
    'BOE_MILLENNIUM',        -- Bank of England Millennium of Macroeconomic Data
    'ALLEN_UNGER',           -- Allen-Unger Global Commodity Prices Database
    'GPIH_UCDAVIS',          -- Global Price and Income History Group, UC Davis
    'NBER_MACROHISTORY',     -- NBER Macrohistory Database
    'HOMER_SYLLA',           -- A History of Interest Rates
    'JASTRAM_GOLDEN',        -- Jastram, The Golden Constant
    'WORLD_GOLD_COUNCIL',    -- WGC historical archives
    -- Numismatic + ancient sources
    'CRAWFORD_RRC',          -- Crawford 1985 + 1974 Roman Republican Coinage
    'RIC',                   -- Roman Imperial Coinage catalog
    'RPC',                   -- Roman Provincial Coinage
    'PRICE_PRESCRIPT',       -- Diocletian's Price Edict (CIL III)
    'WILDWINDS',             -- wildwinds.com numismatic database
    'BMC_ANCIENT',           -- British Museum Catalog of Ancient Coins
    -- Government archives
    'FRED',                  -- modern overlap
    'BEA',
    'BLS',
    'ROYAL_MINT',            -- UK Royal Mint historical
    'US_MINT',               -- US Mint historical
    -- Books treated as data sources (manual entry)
    'BERNSTEIN_POG',         -- The Power of Gold, citations from
    'LEWIS_GOLD',            -- Lewis, Gold: The Once and Future Money
    'GOETZMANN_OOV',         -- The Origins of Value
    'RICKARDS',              -- Rickards's gold series compilations
    'GRAEBER_DEBT',          -- Debt: The First 5,000 Years citations
    -- ORBI's own derivations
    'ORBI_DERIVED'
  ])),

  CONSTRAINT historical_money_prices_period_check CHECK (year_end >= year_start),
  CONSTRAINT historical_money_prices_value_positive CHECK (value > 0)
);

CREATE INDEX IF NOT EXISTS idx_historical_money_prices_asset_year
  ON historical_money_prices (asset, year_start DESC, year_end DESC);
CREATE INDEX IF NOT EXISTS idx_historical_money_prices_region
  ON historical_money_prices (region);
CREATE INDEX IF NOT EXISTS idx_historical_money_prices_source
  ON historical_money_prices (source_authority);
-- Each (asset, quote_in, year_start, year_end, source_authority) is unique;
-- multiple sources may give different values for the same period (intentionally
-- preserved as separate rows so we can show the range).
CREATE UNIQUE INDEX IF NOT EXISTS uq_historical_money_prices_key
  ON historical_money_prices (asset, quote_in, year_start, year_end, source_authority);

-- Resolutions table: link each data point back to its source material.
-- Allows storing scanned-page references, alternate readings, errata.
CREATE TABLE IF NOT EXISTS historical_money_prices_resolutions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_id            uuid NOT NULL REFERENCES historical_money_prices(id) ON DELETE CASCADE,
  -- jsonb structure: { scan_url, page_number, alternate_value, alternate_citation,
  --                    methodology_note, errata, scholar_disagreement }
  detail              jsonb NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_historical_money_prices_resolutions_price_id
  ON historical_money_prices_resolutions (price_id);

-- RLS: fully public-read. Historical scholarly data is the most public-domain
-- ORBI data class; we want the world to be able to cite ORBI as a source.
ALTER TABLE historical_money_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_money_prices_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_read_historical_money_prices ON historical_money_prices;
CREATE POLICY public_read_historical_money_prices ON historical_money_prices
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS public_read_historical_money_prices_resolutions ON historical_money_prices_resolutions;
CREATE POLICY public_read_historical_money_prices_resolutions ON historical_money_prices_resolutions
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE historical_money_prices IS
'Citation-grade long-arc monetary history. Roman denarius silver content, medieval gold standards, US dollar vs gold 1792-1971, ancient drachma, etc. ~2,000 rows at completion spanning ~5,000 years. Backs Empire Currency Decay, Hard Money Throughline, and other long-arc multi-book indexes.';

COMMENT ON COLUMN historical_money_prices.confidence IS
'primary = directly attested by contemporary source. scholarly = peer-reviewed reconstruction. estimated = best-guess from indirect evidence. nominal = official fixed price (e.g. US gold standard).';

COMMENT ON COLUMN historical_money_prices.citation IS
'Mandatory full bibliographic reference. Required for every row — this table is for scholarship-grade data only.';

COMMIT;

INSERT INTO public.schema_migrations (version, applied_at, source)
VALUES ('029_historical_money_prices', now(), 'phase_h') ON CONFLICT DO NOTHING;
