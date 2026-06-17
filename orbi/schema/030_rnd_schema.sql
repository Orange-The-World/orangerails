-- 030_rnd_schema.sql
--
-- ORBI R&D shadow-composite schema.
--
-- Research-only data store under each upstream's personal/research-use grant.
-- Never published, never API-exposed, never synced to Cloud. Bilateral
-- commercial use requires re-ingest through licensed channel (Kaiko/CCData).
--
-- Sources permitted in this schema:
--   COINBASE_EXCHANGE — "personal or research purposes only"
--   BITFINEX          — "solely for internal purposes"
--   KAIKO_PREVIEW     — vendor preview / evaluation data
--   CCDATA_PREVIEW    — vendor preview / evaluation data
--
-- Production source authorities (BITSTAMP, KRAKEN, ECB, BANXICO, etc.) are
-- explicitly REJECTED here so a bug cannot accidentally route a production
-- row into the R&D table or vice versa.
--
-- This migration is LOCAL ONLY. It must NEVER be applied to Cloud DEV or
-- Cloud PROD. The cloud sync script excludes the rnd schema by design.

BEGIN;

CREATE SCHEMA IF NOT EXISTS rnd;
COMMENT ON SCHEMA rnd IS
  'Research-only data store under each upstream''s personal/research-use grant. Never published, never API-exposed, never synced to Cloud. Bilateral commercial use requires re-ingest through licensed channel (Kaiko/CCData).';

CREATE TABLE IF NOT EXISTS rnd.exchange_rates_rnd (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency   text NOT NULL,
  target_currency   text NOT NULL,
  bucket_ts         timestamptz NOT NULL,
  granularity       text NOT NULL,
  product           text NOT NULL,
  rate              numeric(20,8) NOT NULL,
  tier              text NOT NULL,
  composite         boolean NOT NULL DEFAULT false,
  composite_via     text,
  provider_count    integer NOT NULL,
  status            text NOT NULL,
  superseded_by_id  uuid,
  fetched_at        timestamptz NOT NULL,
  computed_at       timestamptz NOT NULL,
  provenance        text NOT NULL DEFAULT 'historical-backfill',
  source_authority  text NOT NULL,
  rnd_only          boolean NOT NULL DEFAULT true,
  rnd_attestation   text NOT NULL DEFAULT
    'Coinbase Exchange: "personal or research purposes only". Bitfinex: "solely for internal purposes". ORBI research-purpose attestation: data ingested under upstream research grants, used only for internal shadow-composite variance analysis. Never republished, never API-exposed, never synced to Cloud DEV or PROD. Commercial use blocked until re-ingest through licensed channel (Kaiko/CCData).',

  CONSTRAINT chk_rnd_only_true
    CHECK (rnd_only = true),

  CONSTRAINT chk_rnd_source_authority
    CHECK (source_authority IN ('COINBASE_EXCHANGE', 'BITFINEX', 'KAIKO_PREVIEW', 'CCDATA_PREVIEW')),

  CONSTRAINT chk_rnd_granularity_valid
    CHECK (granularity IN ('1m', '1d')),

  CONSTRAINT chk_rnd_rate_positive
    CHECK (rate > 0),

  CONSTRAINT chk_rnd_status_valid
    CHECK (status IN ('CONFIRMED', 'PENDING', 'CORRECTED')),

  CONSTRAINT chk_rnd_tier_valid
    CHECK (tier IN ('A', 'B', 'B-single', 'C-composite', 'stable')),

  CONSTRAINT uq_rnd_pair_bucket_authority
    UNIQUE (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
);

COMMENT ON TABLE rnd.exchange_rates_rnd IS
  'Research-only data store under each upstream''s personal/research-use grant. Never published, never API-exposed, never synced to Cloud. Bilateral commercial use requires re-ingest through licensed channel (Kaiko/CCData).';

COMMENT ON COLUMN rnd.exchange_rates_rnd.rnd_only IS
  'Hard-coded TRUE via CHECK constraint. Marks every row as research-only so downstream queries and exports can filter unambiguously.';

COMMENT ON COLUMN rnd.exchange_rates_rnd.rnd_attestation IS
  'Verbatim ToS attestation. Anyone reading rows from this table is bound by the language here.';

CREATE INDEX IF NOT EXISTS rnd_exchange_rates_lookup_idx
  ON rnd.exchange_rates_rnd (source_currency, target_currency, granularity, product, bucket_ts DESC);

CREATE INDEX IF NOT EXISTS rnd_exchange_rates_authority_idx
  ON rnd.exchange_rates_rnd (source_authority);

-- Shadow composite output. Same shape as production composite rows, plus rnd_only.
CREATE TABLE IF NOT EXISTS rnd.shadow_composite (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency   text NOT NULL,
  target_currency   text NOT NULL,
  bucket_ts         timestamptz NOT NULL,
  granularity       text NOT NULL,
  product           text NOT NULL,
  rate              numeric(20,8) NOT NULL,
  tier              text NOT NULL,
  composite         boolean NOT NULL DEFAULT true,
  composite_via     text NOT NULL,
  provider_count    integer NOT NULL,
  status            text NOT NULL DEFAULT 'CONFIRMED',
  fetched_at        timestamptz NOT NULL,
  computed_at       timestamptz NOT NULL,
  provenance        text NOT NULL DEFAULT 'rnd-shadow-composite',
  source_authority  text NOT NULL DEFAULT 'ORBI_RND',
  rnd_only          boolean NOT NULL DEFAULT true,
  inputs_jsonb      jsonb,

  CONSTRAINT chk_shadow_rnd_only CHECK (rnd_only = true),
  CONSTRAINT chk_shadow_granularity CHECK (granularity IN ('1m', '1d')),
  CONSTRAINT chk_shadow_rate_positive CHECK (rate > 0),
  CONSTRAINT chk_shadow_tier CHECK (tier IN ('A', 'B', 'B-single', 'C-composite')),
  CONSTRAINT uq_shadow_pair_bucket
    UNIQUE (source_currency, target_currency, bucket_ts, granularity, product)
);

COMMENT ON TABLE rnd.shadow_composite IS
  'Shadow composite output computed from R&D inputs blended with production single-source rows. Research-only. Never published.';

CREATE INDEX IF NOT EXISTS rnd_shadow_lookup_idx
  ON rnd.shadow_composite (source_currency, target_currency, granularity, bucket_ts DESC);

-- Variance report archive (per pair per day vs. published composite).
CREATE TABLE IF NOT EXISTS rnd.shadow_variance_daily (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date       date NOT NULL,
  source_currency   text NOT NULL,
  target_currency   text NOT NULL,
  mean_abs_delta_bps numeric(20,4),
  max_abs_delta_bps  numeric(20,4),
  rows_over_25bps   integer NOT NULL DEFAULT 0,
  sample_count      integer NOT NULL DEFAULT 0,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_variance_per_day_pair UNIQUE (report_date, source_currency, target_currency)
);

COMMENT ON TABLE rnd.shadow_variance_daily IS
  'Daily variance metrics between production ORBI composite and rnd.shadow_composite. Research-only.';

-- Explicit revoke: nobody outside the local owner gets any access.
REVOKE ALL ON SCHEMA rnd FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA rnd FROM PUBLIC;
REVOKE ALL ON SCHEMA rnd FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA rnd FROM anon, authenticated;

COMMIT;
