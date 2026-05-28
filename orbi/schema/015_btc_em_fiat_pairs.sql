-- ORBI migration 015 — BTC × emerging-market fiat extension batch.
--
-- WHY: ORBI's pair basket through migration 013 covers North America, the
-- major Western Europeans, the Nordics, Japan, Korea, India, Brazil,
-- Argentina, Mexico, Turkey, South Africa, and the APAC quartet
-- (HKD/SGD/NZD/AUD). It does not yet publish BTC rates for any of the
-- Southeast-Asian Tiger economies, Central Europe outside the eurozone,
-- LatAm Pacific-coast countries, or the Middle East. This migration
-- closes part of that gap with seven direct pairs and adds three
-- composite-only pairs where no keyless venue lists BTC against the
-- target fiat directly.
--
-- Sources verified live against each exchange's REST API on 2026-05-27.
--
-- Direct coverage added by this migration:
--   BTC/THB: Bitkub (api.bitkub.com /api/v3/market/trades?sym=btc_thb)
--            — Tier B-single, last 2,410,018 THB, 99.20 BTC 24h base volume.
--   BTC/IDR: Indodax (indodax.com /api/ticker/btc_idr)
--            — Tier B-single, last 1,312,277,000 IDR, 20.88 BTC 24h vol.
--            Keyless surface is ticker-only; emits one open=high=low=close
--            candle per fetch (Luno-style).
--   BTC/MYR: Luno Malaysia (api.luno.com /api/1/ticker?pair=XBTMYR)
--            — Tier B-single, last 295,695 MYR, 14.12 BTC 24h vol.
--   BTC/CZK: Coinmate (coinmate.io /api/transactions?currencyPair=BTC_CZK)
--            — Tier B-single, last 1,544,401 CZK, status TRADING.
--   BTC/CLP: Buda (www.buda.com /api/v2/markets/BTC-CLP/trades)
--            — Tier B-single, last 66,102,000 CLP, 2.17 BTC 24h vol.
--   BTC/COP: Buda — Tier B-single, last 270,001,000 COP. Thin volume.
--   BTC/PEN: Buda — Tier B-single, last 254,000 PEN. Thin volume.
--
-- Composite-only (no keyless direct venue surfaced for this batch):
--   BTC/PLN — Polish venues with keyless market APIs were not located in
--             the 2026-05-27 survey. Bitstamp delisted btcpln. Frankfurter
--             publishes USD/PLN daily so the composite (BTC/USD ORBI ×
--             USD/PLN ECB) is reliable.
--   BTC/PHP — PDAX returned HTTP 403 to our infra; Coins.ph public ticker
--             host unreachable. Frankfurter publishes USD/PHP.
--   BTC/ILS — Bits of Gold sits behind Cloudflare bot mitigation; Bitstamp
--             does not list btciils. Frankfurter publishes USD/ILS.
--
-- Documented but NOT wired (future-action candidates):
--   BTC/AED, BTC/SAR — Rain / BitOasis public market data require auth;
--                      ECB does not publish USD/AED or USD/SAR daily
--                      through Frankfurter so no composite fallback works.
--   BTC/UAH — Kuna's public v3/v4 tickers no longer keyless from our
--             hosts; ECB does not publish USD/UAH. Defer.
--   BTC/NGN, BTC/KES — Yellow Card requires auth API. Defer until
--                      Africa expansion warrants a credentials ask.
--
-- ToS compliance: all four new venues (Bitkub, Indodax, Coinmate, Buda)
-- publish their respective endpoints under public/no-auth documentation
-- surfaces with no clauses prohibiting derivative-index use at the
-- 1-rps cadence configured. Phase-0 silent-posture rules apply
-- (no permission email; see migration 008 audit trail).

-- 1. Bitkub — net-new provider, ships INACTIVE per the 004/009/013 pattern.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bitkub', 'primary', FALSE,
   'https://api.bitkub.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-THB"]'::jsonb,
   'free-public',
   'Thai SEC-licensed exchange (Bitkub Online Co., Ltd.). Public /api/v3/market/trades?sym=btc_thb synthesized into 1-min OHLC. Documented 250 req/10s limit; using 1 rps for headroom.'
  )
ON CONFLICT (name) DO NOTHING;

-- 2. Indodax — net-new provider, ticker-only, ships INACTIVE.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('indodax', 'primary', FALSE,
   'https://indodax.com',
   'Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0; +https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-IDR"]'::jsonb,
   'free-public',
   'Indonesian Bappebti-registered exchange (PT Indodax Nasional Indonesia). Keyless surface is /api/ticker/btc_idr only; emits one O=H=L=C=last candle per fetch (Luno-style). User-Agent must carry the Mozilla/5.0 token or origin returns an HTML interstitial. Future API-key upgrade unlocks /tapi trade history and Tier-A voting.'
  )
ON CONFLICT (name) DO NOTHING;

-- 3. Coinmate — net-new provider, ships INACTIVE.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('coinmate', 'primary', FALSE,
   'https://coinmate.io',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-CZK","BTC-EUR"]'::jsonb,
   'free-public',
   'Czech-operated spot exchange (CNB-registered VASP). Public /api/transactions?currencyPair=BTC_CZK aggregated into 1-min OHLC. api.coinmate.io subdomain unreachable from our hosts; endpointBase is the apex coinmate.io. Documented 100 req/60s public limit; using 1 rps for headroom. BTC/EUR is wired up as a diversifier; EUR is already Tier A elsewhere.'
  )
ON CONFLICT (name) DO NOTHING;

-- 4. Buda — net-new provider, ships INACTIVE.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('buda', 'primary', FALSE,
   'https://www.buda.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-CLP","BTC-COP","BTC-PEN"]'::jsonb,
   'free-public',
   'Chilean-headquartered LatAm exchange (formerly SurBTC). Regulated subsidiaries in Chile, Colombia, Peru. Public /api/v2/markets/{id}/trades aggregated into 1-min OHLC. CLP is the deepest of the three (~2 BTC/24h); COP and PEN are noticeably thinner — expect frequent empty-window fetches (no composite fallback exists for these three because ECB does not publish USD/{CLP,COP,PEN} daily).'
  )
ON CONFLICT (name) DO NOTHING;

-- 5. Luno — extend pairs_supported to include BTC-MYR alongside BTC-ZAR.
UPDATE exchange_rate_providers
SET pairs_supported = '["BTC-ZAR","BTC-MYR"]'::jsonb,
    notes = COALESCE(notes,'') || E'\n2026-05-27: extended with BTC/MYR via Luno Malaysia (verified last_trade 295,695 MYR, 14.12 BTC 24h volume).'
WHERE name = 'luno';
