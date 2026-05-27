-- ORBI migration 010 — extend pairs_supported for stablecoin / fiat-peg
-- spot pair tracking.
--
-- WHY: stablecoins are NOT 1:1 with their fiat referent during stress events
-- (USDC depegged to $0.87 during SVB collapse March 2023; USDT has hit
-- $0.95 during liquidity crunches; DAI floats by design). An audit-grade
-- accounting product needs the actual minute-resolution peg for tax basis,
-- not an assumed 1.00.
--
-- We extend three existing primary BTC sources with stablecoin/fiat spot
-- pairs they natively quote. No new provider rows needed — these are extra
-- entries in the pairs_supported JSONB array per provider.
--
-- Verified live against each exchange's REST API on 2026-05-27:
--   Kraken:           USDT/USD, USDC/USD, DAI/USD, PYUSD/USD, EURC/EUR
--   Bitfinex:         USDT/USD (tUSTUSD), USDC/USD (tUDCUSD), DAI/USD (tDAIUSD)
--   Coinbase Exchange: USDT/USD, DAI/USD, PYUSD/USD, EURC/EUR
--     (USDC/USD NOT listed — USDC is Coinbase's home stablecoin, no self-pair)
--
-- Composite fallback is NOT added for stablecoin pairs: the point is to
-- surface peg deviation, which a BTC-cross composite would launder away.
-- If no source returns a candle, the publish FAILS rather than fabricates.

-- Kraken already shipped with USDCUSD/USDTUSD/DAIUSD in seed 002. Add PYUSD
-- and EURC (Kraken accepts EURCEUR as the request symbol).
UPDATE exchange_rate_providers
SET pairs_supported = '["XBTUSD","XBTEUR","XBTGBP","XBTCAD","XBTAUD","XBTJPY","XBTCHF","USDCUSD","USDTUSD","DAIUSD","PYUSDUSD","EURCEUR"]'::jsonb,
    notes = COALESCE(notes,'') || E'\n2026-05-27: extended with PYUSD/USD + EURC/EUR for peg tracking.'
WHERE name = 'kraken';

-- Bitfinex: add stablecoin spots.
UPDATE exchange_rate_providers
SET pairs_supported = '["tBTCUSD","tUSTUSD","tUDCUSD","tDAIUSD"]'::jsonb,
    notes = COALESCE(notes,'') || E'\n2026-05-27: added USDT/USD (tUSTUSD), USDC/USD (tUDCUSD), DAI/USD (tDAIUSD) for peg tracking.'
WHERE name = 'bitfinex';

-- Coinbase Exchange: add stablecoin spots (no USDC-USD self-pair).
UPDATE exchange_rate_providers
SET pairs_supported = '["BTC-USD","BTC-EUR","BTC-GBP","BTC-INR","USDT-USD","DAI-USD","PYUSD-USD","EURC-EUR"]'::jsonb,
    notes = COALESCE(notes,'') || E'\n2026-05-27: added USDT/USD, DAI/USD, PYUSD/USD, EURC/EUR for peg tracking. USDC-USD intentionally NOT added — Coinbase does not list USDC as a quote against itself (404 verified 2026-05-27).'
WHERE name = 'coinbase_exchange';
