# Upbit — ToS audit notes

- **Homepage:** https://upbit.com/
- **API base URL:** https://api.upbit.com/
- **API documentation URL:** https://docs.upbit.com/
- **Terms of service URL (service guide):** https://upbit.com/service_center/guide?id=0
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `c0fc5202f6f856e5e2625c7fba4f460f652bb3961cdfe96019ca76d8aeb817d1`
- **byte length:** 17959

(Korean-language service guide / 이용약관 hub. The detailed terms documents
load as sub-pages via JavaScript and were not retrievable in this audit.)

## Endpoints used

- `GET /v1/candles/minutes/1?market=KRW-BTC&count=N&to={ISO}` — per-minute
  OHLC. Public, no API key required.
- `GET /v1/ticker?markets=KRW-BTC` — health check.

Both are documented under `docs.upbit.com` as **Quotation API** endpoints,
accessible without authentication.

## Relevant clauses

From `docs.upbit.com` (Quotation API section):

> Quotation API requests are subject to a per-IP rate limit of approximately
> 10 requests per second / 600 requests per minute. Exceeding this limit
> results in HTTP 429.

(Paraphrased from English-language docs.upbit.com.) The plug-in uses 1
req/sec.

The Korean-language Terms of Service hub did not yield individual-clause text
in this fetch. A founder-level Korean-language review is recommended before
flipping `active=TRUE`. Upbit's public-API posture is widely consumed by
third-party Bitcoin index providers (Kaiko, CoinDesk Data), which is a
strong implicit signal that public-endpoint consumption for index purposes
is not gated by ToS.

## Assessment

Use of the Quotation API for ORBI's read-only aggregation is consistent with
normal public-API consumption.

## Required attribution

Upbit's Quotation API documentation does not require an attribution string.
ORBI's public methodology page will credit Upbit as a data source.
