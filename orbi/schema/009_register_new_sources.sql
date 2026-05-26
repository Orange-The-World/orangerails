-- ORBI migration 009 — register 11 new live BTC source plug-ins.
--
-- Shipped INACTIVE (active=FALSE). Founder flips active=TRUE per source after
-- the smoke validation under scripts/sources-smoke/multi-source-smoke.ts.
-- Same pattern as 004's coinbase_exchange registration.
--
-- Coverage impact when activated (validated empirically 2026-05-26):
--   - BTC/JPY: B-single → Tier A (kraken + coincheck + bitbank ≥ 3 sources)
--   - BTC/AUD: B-single → Tier A (kraken + independent_reserve + btc_markets)
--   - BTC/TRY: C-composite → direct B+ (btcturk OHLC + paribu ticker fallback)
--   - BTC/ZAR: C-composite → direct B+ (valr OHLC-via-trades + luno ticker)
--   - BTC/KRW: NEW currency, direct B+ (upbit + bithumb)
--   - BTC/ARS: reliability boost (ripio ticker; bitso primary remains)
--
-- Skipped from the original 14-source brief (all require auth — added to
-- founder credentials checklist):
--   - bity         (BTC→CHF not exposed on public estimate endpoint)
--   - bitbns       (api.bitbns.com/.../tickers returns 401 invalid api key)
--   - lemon_cash   (no working keyless quote endpoint located)
--   - bitFlyer     (already on checklist, JFSA-account API key required)
--   - coindcx      (already on checklist)
--
-- All endpoints are free public APIs validated keyless 2026-05-26.

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('coincheck', 'primary', FALSE,
   'https://coincheck.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-JPY"]'::jsonb,
   'free-public',
   'JFSA-licensed Japanese exchange (Monex Group). Public /api/trades synthesized into 1-min OHLC. No official OHLC endpoint. Activates BTC/JPY Tier A together with bitbank + kraken.'
  ),
  ('bitbank', 'primary', FALSE,
   'https://public.bitbank.cc',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-JPY"]'::jsonb,
   'free-public',
   'JFSA-licensed Japanese exchange (bitbank, Inc.). Native /candlestick/1min/{YYYYMMDD} keyless. Documented 10 req/s; using 1 rps for headroom.'
  ),
  ('independent_reserve', 'primary', FALSE,
   'https://api.independentreserve.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-AUD"]'::jsonb,
   'free-public',
   'AUSTRAC + NZ FSPR registered. Public /GetRecentTrades synthesized into 1-min OHLC. No OHLC endpoint on public API. 1 req/s documented limit.'
  ),
  ('btc_markets', 'primary', FALSE,
   'https://api.btcmarkets.net',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-AUD"]'::jsonb,
   'free-public',
   'AUSTRAC-registered. Native /v3/markets/BTC-AUD/candles?timeWindow=1m endpoint keyless. 50 req/10s documented limit.'
  ),
  ('btcturk', 'primary', FALSE,
   'https://graph-api.btcturk.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-TRY"]'::jsonb,
   'free-public',
   'MASAK-registered Turkish exchange. Native /v1/ohlcs per-minute endpoint on graph-api host (api.btcturk.com /api/v2/ohlc returns daily only). Validated 2026-05-26.'
  ),
  ('paribu', 'primary', FALSE,
   'https://www.paribu.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-TRY"]'::jsonb,
   'free-public',
   'Major Turkish exchange. /ticker returns BTC_TL snapshot only — no public OHLC or trade history. B-single-eligible-only (zero volume in candle output, does not vote in VW-median).'
  ),
  ('luno', 'primary', FALSE,
   'https://api.luno.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-ZAR"]'::jsonb,
   'free-public',
   'South African FSCA-licensed exchange. /api/1/ticker keyless. NOTE: documented /api/exchange/1/candles endpoint requires API key as of 2026-05-26 (returns ErrUnauthorized). B-single-eligible-only until founder adds a read-only Luno API key.'
  ),
  ('valr', 'primary', FALSE,
   'https://api.valr.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-ZAR"]'::jsonb,
   'free-public',
   'South African FSCA-licensed exchange. Public /v1/public/BTCZAR/ohlc returned 404 on 2026-05-26 — synthesized from /v1/public/BTCZAR/trades instead (keyless, same Bitso pattern). 600 req/min documented.'
  ),
  ('upbit', 'primary', FALSE,
   'https://api.upbit.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-KRW"]'::jsonb,
   'free-public',
   'South Korea''s largest KRW exchange (Dunamu). Native /v1/candles/minutes/1 keyless. NEW currency: KRW direct B+ when activated together with bithumb.'
  ),
  ('bithumb', 'primary', FALSE,
   'https://api.bithumb.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-KRW"]'::jsonb,
   'free-public',
   'Long-running South Korean exchange. Native /public/candlestick/BTC_KRW/1m keyless. CAUTION: response order is TS, OPEN, CLOSE, HIGH, LOW, VOLUME (NOT conventional OHLC).'
  ),
  ('ripio', 'primary', FALSE,
   'https://app.ripio.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-ARS"]'::jsonb,
   'free-public',
   'Argentina-headquartered CNV-registered exchange. /api/v3/rates returns buy/sell rates only — no OHLC. Mid-price candle emitted; B-single-eligible-only (zero volume). Complements bitso BTC/ARS for reliability.'
  )
ON CONFLICT (name) DO NOTHING;
