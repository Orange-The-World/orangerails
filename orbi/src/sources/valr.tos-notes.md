# VALR — ToS audit notes

- **Homepage:** https://www.valr.com/
- **API base URL:** https://api.valr.com/
- **API documentation URL:** https://docs.valr.com/
- **Terms of service URL:** https://www.valr.com/en/terms-and-conditions
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `f99a371186916968c93b037931aec1e336d218bfe65df04820237d5545660b6b`
- **byte length:** 5481

The fetched page is a client-side-rendered SPA shell — the full T&Cs text
loads via JavaScript and was not retrievable in this audit. The fingerprint
above covers the shell HTML only. Manual browser review by the founder is
recommended before activation.

## Endpoints used

- `GET /v1/public/BTCZAR/trades?limit=100` — recent public trades
  (synthesized to 1-minute OHLC in code).
- `GET /v1/public/BTCZAR/marketsummary` — health check.

Both are documented as public endpoints requiring no API key. Empirically
verified keyless 2026-05-26. Note: the documented `/v1/public/BTCZAR/ohlc`
endpoint returned 404 on 2026-05-26; we use trades instead, same pattern as
Bitso.

## Relevant clauses

VALR's API documentation lists `/v1/public/*` endpoints as accessible without
authentication, with a per-IP rate limit of "600 requests per minute" (10
req/sec). The plug-in uses 1 req/sec.

The terms-and-conditions shell did not yield retrievable clause text in this
fetch. ORBI's posture is to treat use of the documented public endpoints as
consistent with normal API consumption — same as the Bitstamp/Bitfinex
plug-ins — pending founder review of the rendered T&Cs.

## Assessment

Use of `/v1/public/BTCZAR/trades` and `/v1/public/BTCZAR/marketsummary` is
consistent with normal public-API consumption.

## Required attribution

VALR's developer documentation does not require an attribution string. ORBI's
public methodology page will credit VALR as a data source.
