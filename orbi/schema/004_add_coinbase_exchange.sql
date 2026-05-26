-- ORBI migration 004 — register Coinbase Exchange as a primary BTC source.
--
-- Adds BTC/USD, BTC/EUR, BTC/GBP, and BTC/INR coverage. BTC/INR is the bonus —
-- it lifts INR from C-composite (USD cross-rate) to direct Tier B-single.
--
-- Coinbase Exchange does NOT list BTC-CAD; that gap is covered by Bitfinex
-- BTC/CAD (migration unchanged; provider already present in 002_seed_providers).
--
-- Endpoint: GET https://api.exchange.coinbase.com/products/{pair}/candles
-- Free public API, no auth, ~10 req/sec public rate limit.

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('coinbase_exchange', 'primary', TRUE,
   'https://api.exchange.coinbase.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-USD","BTC-EUR","BTC-GBP","BTC-INR"]'::jsonb,
   'free-public',
   'Free public Exchange/Advanced Trade API. No auth required. BTC-INR lifts INR coverage from C-composite to direct Tier B-single. BTC-CAD is NOT listed on Coinbase Exchange (verified 2026-05-26) — CAD coverage comes from Bitfinex BTC/CAD.'
  )
ON CONFLICT (name) DO NOTHING;
