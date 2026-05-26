# Coincheck — ToS audit notes

- **Homepage:** https://coincheck.com/
- **API base URL:** https://coincheck.com/api/
- **API documentation URL:** https://coincheck.com/documents/exchange/api
- **Terms of service URL (intended):** https://coincheck.com/info/legal
- **Date read:** 2026-05-26

## Fetch status

The Japanese legal-terms page (`/info/legal`) blocks unauthenticated programmatic
HTTP retrieval (returned empty body / 0 bytes from both default and Mozilla
user-agents on 2026-05-26). The English-mirror page does the same. The publicly
addressable resource I was able to retrieve programmatically is the API
documentation:

- **URL fetched:** https://coincheck.com/documents/exchange/api
- **sha256 of body:** `a20d6171c768c28dd9681b8e88f4301fc63429e85e438caffcdf16bc7453f5b6`
- **byte length:** 171178

The legal-terms text was not retrievable in this audit. A manual ToS review by
the founder via a browser is recommended before activation.

## Endpoints used

- `GET /api/trades?pair=btc_jpy&limit=N` — recent public trade ticks (synthesized
  to 1-minute OHLC in code).
- `GET /api/ticker?pair=btc_jpy` — health check.

Both are listed in the public API documentation and require no API key.

## Relevant clauses (from API documentation, paraphrased)

The public API documentation describes `/api/trades` and `/api/ticker` as
**Public API** endpoints accessible without authentication. The documentation
does not publish a specific public-API rate-limit number; the industry-typical
posture for Japanese JFSA exchanges is "do not abuse." The plug-in uses 1
req/sec.

## Assessment

Using the documented public endpoints for ORBI's read-only index aggregation
appears consistent with normal public-API consumption — same posture as
existing Bitstamp/Bitfinex plug-ins. The full legal-terms page should be
reviewed by the founder before flipping `active=TRUE`; if Coincheck's
terms-of-use require prior written permission for systematic redistribution,
ORBI either stays Tier B-single from Coincheck (consume only, do not
republish) or routes permission outreach the same way the Kraken plug-in did.

## Required attribution

Coincheck's API documentation does not state an attribution requirement for
data consumed via public endpoints. Out of courtesy, ORBI's public methodology
page will credit Coincheck as a data source.
