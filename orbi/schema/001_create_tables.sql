-- ORBI Phase 0 schema — Orange Rails Supabase Postgres
-- Three tables: canonical rates, audit log, provider registry.
-- See build prompt §6 for full design rationale.

-- Required extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- exchange_rates — canonical published rate per (source, target, bucket, granularity, product)
-- ============================================================

CREATE TABLE IF NOT EXISTS exchange_rates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency   TEXT NOT NULL,                  -- e.g. 'BTC'
  target_currency   TEXT NOT NULL,                  -- e.g. 'USD'
  bucket_ts         TIMESTAMPTZ NOT NULL,           -- start of the partition (UTC)
  granularity       TEXT NOT NULL,                  -- '1m' | '1d'
  product           TEXT NOT NULL,                  -- 'ORBI-M' | 'ORBI-D'
  rate              NUMERIC(20, 8) NOT NULL,        -- canonical VW-median value
  tier              TEXT NOT NULL,                  -- 'A' | 'B' | 'B-single' | 'C-composite' | 'stable'
  composite         BOOLEAN NOT NULL DEFAULT FALSE,
  composite_via     TEXT,                           -- e.g. 'BTC->USD * USD->MXN' when composite=true
  provider_count    INTEGER NOT NULL,               -- how many sources contributed (after dropping zero-volume)
  status            TEXT NOT NULL,                  -- 'CONFIRMED' | 'PENDING' | 'CORRECTED'
  superseded_by_id  UUID REFERENCES exchange_rates(id),  -- for corrections; original retained
  fetched_at        TIMESTAMPTZ NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL,

  CONSTRAINT uq_rates_pair_bucket UNIQUE (source_currency, target_currency, bucket_ts, granularity, product),
  CONSTRAINT chk_rate_positive CHECK (rate > 0),
  CONSTRAINT chk_tier_valid CHECK (tier IN ('A','B','B-single','C-composite','stable')),
  CONSTRAINT chk_granularity_valid CHECK (granularity IN ('1m','1d')),
  CONSTRAINT chk_product_valid CHECK (product IN ('ORBI-M','ORBI-D')),
  CONSTRAINT chk_status_valid CHECK (status IN ('CONFIRMED','PENDING','CORRECTED')),
  CONSTRAINT chk_composite_consistency CHECK (
    (composite = FALSE AND composite_via IS NULL) OR
    (composite = TRUE  AND composite_via IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rates_lookup
  ON exchange_rates (source_currency, target_currency, granularity, product, bucket_ts DESC);

CREATE INDEX IF NOT EXISTS idx_rates_status_pending
  ON exchange_rates (status, fetched_at)
  WHERE status = 'PENDING';

COMMENT ON TABLE  exchange_rates IS 'Canonical published ORBI rates. One row per (source_currency, target_currency, bucket_ts, granularity, product).';
COMMENT ON COLUMN exchange_rates.tier IS 'A=3+ direct sources, B=1-2 direct, C-composite=via USD cross-rate, stable=stablecoin/USD';
COMMENT ON COLUMN exchange_rates.superseded_by_id IS 'Set when this row has been corrected; original retained for audit per §15 of methodology';

-- ============================================================
-- exchange_rate_resolutions — per-rate audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS exchange_rate_resolutions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_id               UUID NOT NULL REFERENCES exchange_rates(id) ON DELETE CASCADE,
  provider_responses    JSONB NOT NULL,
  -- example: { "kraken": {"close": 67234.50, "volume": 18.42, "success": true},
  --           "bitstamp": {"close": 67228.75, "volume": 24.15, "success": true}, ... }
  providers_succeeded   TEXT[] NOT NULL,
  -- example: ["kraken","bitstamp","bitfinex","mempool.space"]
  providers_failed      JSONB,
  -- example: [{"name":"bitfinex","error":"timeout after 3s"}]
  outliers_discarded    JSONB,
  median_calculation    TEXT,                       -- human-readable cumulative-volume walk
  fetched_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resolutions_rate ON exchange_rate_resolutions(rate_id);

COMMENT ON TABLE exchange_rate_resolutions IS 'Per-rate audit log. Stores every input candle that fed every published rate. Anyone can reproduce any rate from this table.';

-- ============================================================
-- exchange_rate_providers — provider registry + activation control
-- ============================================================

CREATE TABLE IF NOT EXISTS exchange_rate_providers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL UNIQUE,         -- 'kraken', 'bitstamp', 'bitfinex', etc.
  role                TEXT NOT NULL,                -- 'primary' | 'secondary' | 'cross-check' | 'cross-rate' | 'inactive'
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  endpoint_base       TEXT NOT NULL,
  user_agent          TEXT NOT NULL,                -- our identifying UA string
  rate_limit_rps      NUMERIC(4, 2) NOT NULL,       -- our self-imposed cadence cap (requests per second)
  pairs_supported     JSONB NOT NULL,               -- array of supported pair codes
  permission_status   TEXT NOT NULL DEFAULT 'free-public',
  -- 'free-public' | 'written-permission-sought' | 'written-permission-granted' | 'dla-signed' | 'revoked' | 'tos-review-in-progress'
  permission_doc_url  TEXT,                         -- link to written confirmation if applicable
  last_success_at     TIMESTAMPTZ,
  last_failure_at     TIMESTAMPTZ,
  failure_count_24h   INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_role_valid CHECK (role IN ('primary','secondary','cross-check','cross-rate','inactive')),
  CONSTRAINT chk_permission_valid CHECK (permission_status IN (
    'free-public','written-permission-sought','written-permission-granted',
    'dla-signed','revoked','tos-review-in-progress'
  ))
);

CREATE INDEX IF NOT EXISTS idx_providers_active ON exchange_rate_providers(active, role);

COMMENT ON TABLE  exchange_rate_providers IS 'Source registry. The active=FALSE flag is the one-flip switch for cease-and-desist response per the Hybrid Asymmetric Risk-Management Strategy.';
COMMENT ON COLUMN exchange_rate_providers.active IS 'Set FALSE to disable a source on a cease-and-desist. Calculation engine excludes inactive sources at request time.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION orbi_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_providers_updated_at ON exchange_rate_providers;
CREATE TRIGGER trg_providers_updated_at
  BEFORE UPDATE ON exchange_rate_providers
  FOR EACH ROW EXECUTE FUNCTION orbi_set_updated_at();
