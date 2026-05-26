# BTCTurk — ToS audit notes

- **Homepage:** https://www.btcturk.com/
- **API base URL:** https://api.btcturk.com/ (ticker) and https://graph-api.btcturk.com/ (OHLC)
- **API documentation URL:** https://docs.btcturk.com/
- **Terms of service URL:** https://www.btcturk.com/yardim/btcturk-kullanim-sozlesmesi
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `f6aa66aac61bb8e41bf4e50fae134a1ac809aef3acc79b7364ccd3eca9f4773d`
- **byte length:** 265161

(Turkish-language Kullanım Sözleşmesi.)

## Endpoints used

- `GET https://graph-api.btcturk.com/v1/klines/history?symbol=BTCTRY&resolution=1&from={s}&to={s}` —
  per-minute OHLC, TradingView-UDF columnar response. NOTE: `/v1/ohlcs` on
  the same host returns DAILY bars only — do not confuse the two.
- `GET https://api.btcturk.com/api/v2/ticker?pairSymbol=BTCTRY` — health check.

Both are documented as public endpoints requiring no API key.

## Relevant clauses

The full agreement is in Turkish; the publicly observable API documentation at
docs.btcturk.com lists `/api/v2/ohlc` and the graph-api `/v1/ohlcs` as public
endpoints accessible without authentication, with a rate limit of "100
requests per 10 seconds" per IP. The plug-in uses 1 req/sec.

The Kullanım Sözleşmesi governs the brokerage relationship between BTCTurk and
its Turkish-resident account-holders; it does not contain a clause specifically
prohibiting third-party consumption of public market-data endpoints for index
calculation. A founder-level Turkish-language review is recommended before
flipping `active=TRUE`.

## Assessment

Use of the documented public OHLC and ticker endpoints for ORBI's read-only
aggregation is consistent with normal public-API consumption.

## Required attribution

API docs do not require an attribution string. ORBI's public methodology page
will credit BTCTurk as a data source.
