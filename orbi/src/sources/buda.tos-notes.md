# Buda — ToS audit notes

- **Homepage:** https://www.buda.com/
- **API base URL:** https://www.buda.com/api/v2/
- **API documentation URL:** https://api.buda.com/
- **Terms of service URL:** https://www.buda.com/terminos
- **Date read:** 2026-05-27

## Endpoints used

- `GET /api/v2/markets/BTC-{CLP,COP,PEN}/trades` — recent trades,
  public/keyless.
- `GET /api/v2/markets/BTC-CLP/ticker` — health-check ticker,
  public/keyless.

No documented hard rate limit; the plug-in uses 1 req/sec.

## Assessment

Buda's terminos cover the use of the trading platform. The public API
documentation explicitly designates `/api/v2/markets/{id}/trades` and
`/api/v2/markets/{id}/ticker` as unauthenticated public endpoints with no
derivative-use clause. The 1 rps polling for ORBI's B-single-eligible
roles (one per currency) is consistent with the documented public-API
posture.

CLP volume is the deepest of the three pairs (~2 BTC/24h on activation
day); COP and PEN are noticeably thinner (sub-0.1 BTC/24h each) so the
composite fallback configured in `forward-fill.ts` will frequently cover
empty-window fetches on those pairs. Once a second CLP source is added,
BTC/CLP becomes a Tier A candidate.

Posture: silent-friendly (Phase 0).

## Required attribution

No attribution string is required. ORBI's methodology page will credit
Buda as a LatAm source.
