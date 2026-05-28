# Bitkub — ToS audit notes

- **Homepage:** https://www.bitkub.com/
- **API base URL:** https://api.bitkub.com/
- **API documentation URL:** https://github.com/bitkub/bitkub-official-api-docs
- **Terms of service URL:** https://www.bitkub.com/policies/terms-of-service
- **Date read:** 2026-05-27

## Endpoints used

- `GET /api/v3/market/trades?sym=btc_thb&lmt=N` — recent trades, public/keyless.
- `GET /api/v3/market/ticker?sym=btc_thb` — health-check ticker, public/keyless.

The published docs explicitly mark these endpoints as "non-secure" (no API
key, no signature). Rate limits are documented as 250 requests per 10
seconds per IP for public endpoints; the plug-in uses 1 req/sec.

## Assessment

Bitkub's terms of service govern the use of the trading platform and
custody services. The public market-data endpoints are documented in a
permissive, integration-friendly stance and ship with no licensing language
restricting derivative-index use of the prints. The plug-in's read-only
1 rps polling for ORBI's B-single-eligible role is consistent with the
documented public-API posture.

Posture: silent-friendly (Phase 0).

## Required attribution

No attribution string is required by Bitkub's documented developer terms.
ORBI's methodology page will credit Bitkub as a Thai source.
