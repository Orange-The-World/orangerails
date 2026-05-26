-- ORBI Phase 0 seed — initial provider registry
-- Seven providers: six BTC sources + Frankfurter (fiat cross-rate).

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  -- Primary BTC sources
  ('kraken', 'primary', TRUE,
   'https://api.kraken.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.5,
   '["XBTUSD","XBTEUR","XBTGBP","XBTCAD","XBTAUD","XBTJPY","XBTCHF","USDCUSD","USDTUSD","DAIUSD"]'::jsonb,
   'written-permission-sought',
   'Kraken docs require prior permission for non-personal commercial use. Email sent Phase 0 week 1.'
  ),
  ('bitstamp', 'primary', TRUE,
   'https://www.bitstamp.net/api',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   2.0,
   '["btcusd","btceur","btcgbp"]'::jsonb,
   'free-public',
   'Free public API for internal use. DLA email deferred to Phase 3 commercial trigger.'
  ),
  ('bitfinex', 'primary', TRUE,
   'https://api-pub.bitfinex.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.33,
   '["tBTCUSD"]'::jsonb,
   'free-public',
   'Silent ToS posture. No outreach per Hybrid Asymmetric Risk-Management Strategy.'
  ),
  ('mempool.space', 'primary', TRUE,
   'https://mempool.space',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTCUSD","BTCEUR","BTCGBP","BTCCAD","BTCCHF","BTCAUD","BTCJPY"]'::jsonb,
   'free-public',
   'Community-operated MIT-licensed Bitcoin block explorer.'
  ),
  ('bitso', 'primary', TRUE,
   'https://api.bitso.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["btc_mxn","btc_brl","btc_ars","btc_usd","btc_usdt"]'::jsonb,
   'free-public',
   'Silent ToS posture confirmed 2026-05-25. Courtesy email to api@bitso.com (does not gate launch). No official OHLC endpoint — plug-in aggregates from /v3/trades/.'
  ),
  ('mercado_bitcoin', 'primary', TRUE,
   'https://api.mercadobitcoin.net',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-BRL","BTC-USDT","BTC-USDC"]'::jsonb,
   'free-public',
   'ToS research 2026-05-25 confirmed Bitfinex-style posture: no no-indexes clause; public data carved out of Confidential Information. Real /api/v4/candles endpoint. Courtesy email to contato@mercadobitcoin.com.br (does not gate launch).'
  ),
  -- Fiat cross-rate (NOT a BTC source)
  ('frankfurter', 'cross-rate', TRUE,
   'https://api.frankfurter.app',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["USD-base","EUR-base","30+ ECB-published fiat pairs"]'::jsonb,
   'free-public',
   'ECB data via Frankfurter. Used for fiat-cross composites (Tier C) and pure fiat-fiat rates. Free community project.'
  )
ON CONFLICT (name) DO NOTHING;
