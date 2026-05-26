# Luno — ToS audit notes

- **Homepage:** https://www.luno.com/
- **API base URL:** https://api.luno.com/
- **API documentation URL:** https://www.luno.com/en/developers/api
- **Terms of service URL:** https://www.luno.com/legal/terms-of-use
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `2d431e9fbae1ddadb89a8ec15921b81a2e130f0a91e3f31e1798d70580e581d7`
- **byte length:** 858204

## Endpoints used

- `GET /api/1/ticker?pair=XBTZAR` — ticker, public/keyless.
- (NOT used) `GET /api/exchange/1/candles?pair=XBTZAR&since=...&duration=60`
  — empirically required an API key as of 2026-05-26 (`ErrUnauthorized`).
  Brief incorrectly assumed it was keyless.

## Relevant clauses

The terms-of-use page is a long client-rendered document; the principal
clauses observable in the fetched HTML are the standard "account holder
relationship" terms. Luno's API documentation explicitly distinguishes
"Public" endpoints (no auth, currently limited to ticker, order book, recent
trades) from "Read" endpoints (auth required, includes candles/charts).

Rate-limit guidance from the API documentation: 300 requests per minute (5
req/sec) per IP on public endpoints. The plug-in uses 1 req/sec.

No clause prohibiting consumption of `/api/1/ticker` for third-party index
calculation was observed.

## Assessment

Use of the public `/api/1/ticker` endpoint at 1 req/sec for ORBI's read-only
B-single-eligible role is consistent with Luno's documented public-API
posture.

To upgrade Luno to Tier A voting in the VW-median, ORBI needs a Luno API key
with the "Perm_R_Read" scope (free to create from any Luno account). Added
to the founder credentials checklist.

## Required attribution

Luno's developer terms do not require an attribution string. ORBI's public
methodology page will credit Luno as a data source.
