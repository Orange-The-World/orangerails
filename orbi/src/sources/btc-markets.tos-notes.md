# BTC Markets — ToS audit notes

- **Homepage:** https://www.btcmarkets.net/
- **API base URL:** https://api.btcmarkets.net/
- **API documentation URL:** https://docs.btcmarkets.net/v3/
- **Terms of service URL:** https://www.btcmarkets.net/legal/terms-of-use
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `51862c0e0935373f58fba17c64b59b4eef255d874d56be8d9403332c0db27025`
- **byte length:** 5463

The fetched page is a client-side-rendered SPA shell — the full legal text
loads via JavaScript and was not retrievable in this audit. The fingerprint
above covers the shell HTML only. Manual browser review by the founder is
recommended before activation.

## Endpoints used

- `GET /v3/markets/BTC-AUD/candles?timeWindow=1m&from={ISO}&to={ISO}` — 1-min
  OHLC.
- `GET /v3/markets/BTC-AUD/ticker` — health check.

Both are documented as public endpoints requiring no API key.

## Relevant clauses

From the API documentation:

> Public endpoints (those under `/v3/markets/*` that do not require an API key)
> are rate-limited per IP to 50 requests per 10 seconds.

(Paraphrased from docs.btcmarkets.net/v3/.) The plug-in uses 1 req/sec.

The terms-of-use shell did not yield retrievable clause text in this fetch.
ORBI's posture is to treat use of the documented public endpoints as
consistent with normal API consumption — same as the Bitstamp/Bitfinex
plug-ins — pending founder review of the rendered ToS page.

## Assessment

Use of `/v3/markets/BTC-AUD/candles` and `/v3/markets/BTC-AUD/ticker` is
documented as keyless public consumption with a per-IP rate limit. ORBI's
1 req/sec posture is well within that envelope. The full terms-of-use page
should be reviewed by the founder before flipping `active=TRUE`.

## Required attribution

The API documentation does not require an attribution string. ORBI's public
methodology page will credit BTC Markets as a data source.
