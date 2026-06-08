-- ORBI 031 — Bitcoin network metrics (mempool.space).
--
-- Network-grade truth data for the orange-pill catalog: hashrate, difficulty,
-- Lightning Network growth, mining-pool concentration, block subsidy /
-- transaction counts, miner revenue. None of these fit the price /
-- commodity / monetary-aggregate truth tables, so we use one wide
-- flexible table keyed by (metric_kind, period, context_jsonb).
--
-- Source posture per memory `feedback_orbi_silent_posture.md` and Phase F
-- mempool.space ToS deep-dive (AGPLv3 ethos, public endpoints, no ToS
-- restrictions surfaced for the network-data API surface).
--
-- Backs orange-pill indexes such as:
--   - Hashrate ATH cadence vs fiat M2
--   - Lightning capacity vs SWIFT throughput
--   - Pool concentration vs decentralization story
--   - Subsidy halving curve vs fiat dilution

BEGIN;

CREATE TABLE IF NOT EXISTS bitcoin_network_metrics (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical metric kinds. Add to the CHECK below if you introduce a new one.
  --   HASHRATE          — network avg hashrate (EH/s)
  --   DIFFICULTY        — network difficulty (raw)
  --   DIFFICULTY_ADJ    — adjustment factor at retarget (ratio)
  --   LN_CAPACITY       — Lightning total network capacity (sats)
  --   LN_CHANNELS       — Lightning channel count
  --   LN_NODES          — Lightning node count
  --   LN_TOR_NODES      — Lightning tor-only node count
  --   LN_CLEARNET_NODES — Lightning clearnet-only node count
  --   LN_AVG_CAPACITY   — Lightning avg channel capacity (sats)
  --   LN_MED_CAPACITY   — Lightning median channel capacity (sats)
  --   POOL_SHARE        — mining-pool share (percent, blocks-mined / blockCount)
  --   POOL_BLOCKS       — mining-pool block count over window
  --   BLOCK_REWARD      — per-block coinbase + fees (sats)
  --   BLOCK_FEES        — per-block fees (sats)
  --   BLOCK_SIZE        — per-block size (bytes)
  --   BLOCK_TX_COUNT    — per-block tx count
  --   BLOCK_DIFFICULTY  — per-block difficulty
  --   MINING_REVENUE    — aggregated miner revenue over window (sats)
  --   MINING_FEES       — aggregated miner fees over window (sats)
  --   MINING_TX_COUNT   — aggregated tx count over window
  metric_kind         text NOT NULL,

  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_label        text NOT NULL,
  value               numeric NOT NULL,
  -- Unit hint. Examples: 'EH/s','TH/s','sats','BTC','count','percent_share',
  -- 'bytes','tx_count','ratio','difficulty'.
  unit                text NOT NULL,
  -- Free-form context (block_height, pool name/slug, window timeframe, etc.)
  context_jsonb       jsonb,

  source_authority    text NOT NULL,
  source_url          text NOT NULL,
  citation            text NOT NULL,
  provenance          text NOT NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  inserted_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bnm_metric_kind_check CHECK (metric_kind = ANY (ARRAY[
    'HASHRATE','DIFFICULTY','DIFFICULTY_ADJ',
    'LN_CAPACITY','LN_CHANNELS','LN_NODES','LN_TOR_NODES','LN_CLEARNET_NODES',
    'LN_AVG_CAPACITY','LN_MED_CAPACITY',
    'POOL_SHARE','POOL_BLOCKS',
    'BLOCK_REWARD','BLOCK_FEES','BLOCK_SIZE','BLOCK_TX_COUNT','BLOCK_DIFFICULTY',
    'MINING_REVENUE','MINING_FEES','MINING_TX_COUNT'
  ])),
  CONSTRAINT bnm_provenance_check CHECK (provenance = ANY (ARRAY[
    'historical-backfill','forward-fill','derived'
  ])),
  CONSTRAINT bnm_source_authority_check CHECK (source_authority = ANY (ARRAY[
    'MEMPOOL_SPACE','LIGHTNING_NETWORK','ORBI'
  ])),
  CONSTRAINT bnm_period_check CHECK (period_end >= period_start)
);

-- Uniqueness: same metric, same period, same context, same source = same row.
-- coalesce empty-jsonb default so NULL context still dedupes correctly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bnm_key
  ON bitcoin_network_metrics (
    metric_kind, period_start, period_end,
    (coalesce(context_jsonb, '{}'::jsonb)),
    source_authority
  );

CREATE INDEX IF NOT EXISTS idx_bnm_kind_period
  ON bitcoin_network_metrics (metric_kind, period_start DESC);

COMMENT ON TABLE bitcoin_network_metrics IS
  'Bitcoin network truth data (hashrate, difficulty, Lightning, pools, blocks). '
  'Backs ORBI orange-pill indexes. Source: mempool.space public REST API; '
  'see Phase F ToS deep-dive and Phase H mempool loaders.';

COMMIT;
