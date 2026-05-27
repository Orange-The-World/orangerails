-- ORBI migration 013 — geographic-gap BTC/fiat extension (HKD, SGD, NOK, SEK,
-- DKK, NZD).
--
-- WHY: the existing 14-pair direct basket (USD, EUR, GBP, CAD, AUD, JPY, CHF,
-- MXN, BRL, ARS, TRY, ZAR, KRW, INR) leaves Hong Kong, Singapore, the Nordics,
-- and New Zealand without an ORBI rate of their own. For users denominating
-- books in those currencies, ORBI was forced into composite-only rates with no
-- direct local venue cross-check. This migration adds at least one direct
-- source per pair (except SEK, which no keyless venue currently lists),
-- plus a composite fallback so every pair publishes a Tier-C row when the
-- direct source is dry.
--
-- Sources verified live against each exchange's REST API on 2026-05-27.
--
-- Direct coverage:
--   BTC/HKD: BTSE (api.btse.com /spot/api/v3.2/ohlcv?symbol=BTC-HKD)
--            — Tier B-single, 52,894,528 HKD 24h volume on activation day.
--   BTC/SGD: Independent Reserve (Public/GetRecentTrades, Xbt/Sgd)
--            — Tier B-single, live trades within the hour on activation day.
--   BTC/NOK: Firi (api.firi.com /v2/markets/BTCNOK/history)
--            — Tier B-single, 4.41 BTC 24h vol; only Nordic-licensed venue
--              with a keyless public market API.
--   BTC/DKK: Firi (BTCDKK) — Tier B-single, thin but live.
--   BTC/NZD: Independent Reserve (Xbt/Nzd) — Tier B-single, live trades.
--   BTC/SEK: NO direct source — composite-only via BTC/USD ORBI × USD/SEK
--            Frankfurter. Several Swedish exchanges (Safello, Trijo, BTCX)
--            either require auth or no longer expose a public market API.
--            Re-evaluate if a keyless SEK source surfaces.
--
-- Composite fallback for HKD/SGD/NOK/DKK/NZD is added in forward-fill.ts
-- alongside the existing TRY/ZAR pattern (direct attempted first, composite
-- written behind it; ON CONFLICT DO UPDATE replaces with the later write per
-- the same convention as TRY/ZAR — founder is aware and intends to dedupe
-- once direct stability is proven).
--
-- ToS compliance: BTSE and Firi public endpoints carry no auth requirement
-- and no ToS clause prohibiting backend polling at the 1-rps cadence used
-- here. Phase-0 silent-posture rules apply (no permission email; see
-- migration 008 audit trail).

-- 1. BTSE — net-new provider, ships INACTIVE per same convention as 004/009.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('btse', 'primary', FALSE,
   'https://api.btse.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-HKD"]'::jsonb,
   'free-public',
   'BVI-incorporated spot exchange. Native /spot/api/v3.2/ohlcv 1-minute candle endpoint, keyless. Activated for BTC/HKD (liquid). BTC/NZD is listed by the venue but volume is zero and the price stale; we get BTC/NZD from Independent Reserve instead.'
  )
ON CONFLICT (name) DO NOTHING;

-- 2. Firi — net-new provider, ships INACTIVE.
INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('firi', 'primary', FALSE,
   'https://api.firi.com',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   1.0,
   '["BTC-NOK","BTC-DKK"]'::jsonb,
   'free-public',
   'Finanstilsynet-registered Norwegian exchange (formerly MiraiEx). No native OHLC endpoint — /v2/markets/{id}/history returns recent fills, aggregated into 1-minute candles. BTC/SEK is NOT listed by Firi; SEK is composite-only.'
  )
ON CONFLICT (name) DO NOTHING;

-- 3. Independent Reserve — extend pairs_supported with SGD + NZD.
UPDATE exchange_rate_providers
SET pairs_supported = '["BTC-AUD","BTC-SGD","BTC-NZD"]'::jsonb,
    notes = COALESCE(notes,'') || E'\n2026-05-27: extended with BTC/SGD and BTC/NZD (verified live trades 2026-05-27).'
WHERE name = 'independent_reserve';
