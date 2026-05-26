# Bithumb — ToS audit notes

- **Homepage:** https://www.bithumb.com/
- **API base URL:** https://api.bithumb.com/
- **API documentation URL:** https://apidocs.bithumb.com/
- **Terms of service URL:** https://www.bithumb.com/customer-support/info-guide/terms
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `f62023e72d02ce1393edb27e556e765a39bb93be8df0b4c82aa1050048990f32`
- **byte length:** 9229

The fetched page is a client-side-rendered SPA shell — the full Korean
terms document loads via JavaScript and was not retrievable in this audit.
Founder Korean-language review of the rendered page is recommended.

## Endpoints used

- `GET /public/candlestick/BTC_KRW/1m` — per-minute candlesticks. Public,
  no API key required.
- `GET /public/ticker/BTC_KRW` — health check.

Both are documented as **Public API** endpoints accessible without
authentication.

## Relevant clauses

From `apidocs.bithumb.com`:

> Public API endpoints have a per-IP rate limit of approximately 150 requests
> per second. Exceeding this returns HTTP 429.

(Paraphrased from English Bithumb API docs.) The plug-in uses 1 req/sec.

The Korean-language terms page did not yield individual-clause text. Bithumb,
like Upbit, is widely consumed by third-party index providers; the implicit
posture for public-endpoint consumption is permissive.

CAUTION: Bithumb returns candle tuples in OPEN, CLOSE, HIGH, LOW, VOLUME
order — NOT the conventional OHLC order. The plug-in code unpacks this
explicitly.

## Assessment

Use of `/public/candlestick` and `/public/ticker` for ORBI's read-only
aggregation is consistent with normal public-API consumption.

## Required attribution

Bithumb's API documentation does not require an attribution string. ORBI's
public methodology page will credit Bithumb as a data source.
