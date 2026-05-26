# Independent Reserve — ToS audit notes

- **Homepage:** https://www.independentreserve.com/
- **API base URL:** https://api.independentreserve.com/
- **API documentation URL:** https://www.independentreserve.com/products/api
- **Terms of service URL:** https://www.independentreserve.com/legal/terms-of-use
- **Date read:** 2026-05-26

## ToS fingerprint

- **sha256 of body:** `f38b4100b7aec98230700e2d601df7500c20b21f733f88d5382b480ae16b9058`
- **byte length:** 116384

## Endpoints used

- `GET /Public/GetRecentTrades?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Aud&numberOfRecentTradesToRetrieve=100`
  — recent public trade ticks (synthesized to 1-min OHLC in code).
- `GET /Public/GetMarketSummary?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Aud`
  — health check.

Both are `/Public/*` endpoints and require no API key.

## Relevant clauses

The terms-of-use is the brokerage relationship between Independent Reserve and
its account-holders. The API documentation states:

> **Rate limits.** Do not exceed 1 request per second for unauthenticated
> public endpoints. Excessive usage may result in temporary IP throttling.

(Paraphrased from the API documentation page; exact wording subject to change.)

The plug-in uses 1 req/sec to stay within this guidance.

The terms-of-use does not contain a clause prohibiting use of public market
data for index calculation by an unaffiliated third party.

## Assessment

Use of `/Public/GetRecentTrades` and `/Public/GetMarketSummary` for ORBI's
read-only index aggregation is consistent with the documented public-API
posture. Same pattern as Bitfinex/Bitstamp plug-ins.

## Required attribution

The API documentation does not require a specific attribution string. ORBI's
public methodology page will credit Independent Reserve as a data source as a
matter of courtesy.
