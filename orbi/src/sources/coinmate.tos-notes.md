# Coinmate — ToS audit notes

- **Homepage:** https://coinmate.io/
- **API base URL:** https://coinmate.io/api/ (note: NOT api.coinmate.io —
  that subdomain is unreachable from our hosts; the public API lives on
  the apex domain).
- **API documentation URL:** https://coinmate.docs.apiary.io/
- **Terms of service URL:** https://coinmate.io/terms
- **Date read:** 2026-05-27

## Endpoints used

- `GET /api/transactions?currencyPair=BTC_CZK&minutesIntoHistory=N` —
  recent trades window, public/keyless.
- `GET /api/ticker?currencyPair=BTC_CZK` — health-check ticker,
  public/keyless.

Rate limits documented as 100 requests / 60 seconds per IP for public
endpoints; the plug-in uses 1 req/sec.

## Assessment

Coinmate's published terms govern the use of the trading platform.
The Apiary-hosted API documentation explicitly separates "public" and
"private" endpoints; the two endpoints used here are in the "public"
section with no auth or signature requirement and no derivative-use
restriction. The 1 rps polling for ORBI's B-single-eligible role is
consistent with the documented public-API posture.

Posture: silent-friendly (Phase 0).

## Required attribution

No attribution string is required. ORBI's methodology page will credit
Coinmate as the Czech source.
