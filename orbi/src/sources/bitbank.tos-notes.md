# bitbank — ToS audit notes

- **Homepage:** https://bitbank.cc/
- **API base URL:** https://public.bitbank.cc/
- **API documentation URL:** https://github.com/bitbankinc/bitbank-api-docs/
- **Terms of service URL:** https://bitbank.cc/legal/agreement/
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `1d5af61d263a68ac62f211d993d2e2aba23afe8aca07671cb13d34051c56a913`
- **byte length:** 40445

## Endpoints used

- `GET https://public.bitbank.cc/{pair}/candlestick/1min/{YYYYMMDD}` — 1-min
  candle list for the given UTC date.
- `GET https://public.bitbank.cc/{pair}/ticker` — health check.

Both are listed under the **Public API** section of the bitbank-api-docs GitHub
repository and require no API key.

## Relevant clauses

The agreement page is the consumer brokerage-account agreement governing the
relationship between a Japanese-resident user and bitbank, Inc. — it does not
specifically cover bot/API data consumption.

The dedicated API documentation (`bitbankinc/bitbank-api-docs` on GitHub)
describes the public endpoints used here as accessible without authentication
and notes a soft cap of "approximately 10 requests per second" per IP for the
public endpoints. The plug-in uses 1 req/sec.

No clause prohibiting use of the public market-data endpoints for index
calculation was observed in either the agreement or the API docs.

## Assessment

Using `/{pair}/candlestick/1min/{YYYYMMDD}` and `/{pair}/ticker` from
`public.bitbank.cc` is consistent with normal public-API consumption. Same
posture as Bitstamp/Bitfinex/Coinbase Exchange plug-ins. No prior-permission
gating documented.

## Required attribution

bitbank's documentation does not require an attribution string for use of
public market-data endpoints. ORBI's public methodology page will credit
bitbank as a data source as a matter of courtesy.
