# Indodax — ToS audit notes

- **Homepage:** https://indodax.com/
- **API base URL:** https://indodax.com/api/
- **API documentation URL:** https://github.com/btcid/indodax-official-api-docs
- **Terms of service URL:** https://indodax.com/syaratketentuan
- **Date read:** 2026-05-27

## Endpoints used

- `GET /api/ticker/btc_idr` — public/keyless ticker.
- (NOT used) `/api/btc_idr/trades` — empirically returns the marketing site
  HTML instead of a JSON trade array; recent-trades retrieval requires
  the authenticated `/tapi` private API.

User-Agent: Indodax serves an HTML interstitial to non-browser UAs (curl,
wget, etc.). The plug-in's UA prepends the `Mozilla/5.0` token to the
Orange-Rails-ORBI contact string so the origin returns JSON.

## Assessment

Indodax's terms of service are written in Indonesian and govern the use
of the trading platform. The public `/api/ticker/*` endpoint is documented
in the official API repository as part of the unauthenticated public
endpoint surface, with no licensing language restricting derivative
statistical use. The plug-in's 1 rps polling for ORBI's B-single-eligible
role is consistent with the documented public-API posture.

Because Indodax only exposes a ticker (no trade-stream / OHLC) on the
keyless surface, this source publishes one open=high=low=close=last candle
per fetch with volume=0 — the same pattern Luno uses for BTC-ZAR.

Posture: silent-friendly (Phase 0). A future API-key upgrade would unlock
authenticated trade history and let Indodax vote in the VW-median proper.

## Required attribution

No attribution string is required. ORBI's methodology page will credit
Indodax as the Indonesian source.
