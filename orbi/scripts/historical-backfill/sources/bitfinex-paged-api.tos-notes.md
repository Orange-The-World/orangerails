# Bitfinex paged-API — ToS audit notes

- **Source name in ORBI:** `bitfinex-paged`
- **API endpoint:** <https://api-pub.bitfinex.com/v2/candles/trade:1m:t{PAIR}/hist>
- **Terms of Service URL (fetched):** <https://www.bitfinex.com/legal/terms>
- **API Docs URL (fetched):** <https://docs.bitfinex.com/docs/introduction>
- **Date read:** 2026-05-26
- **sha256 (Terms page HTML):** `761bb2b8fc70d30a53d3f794df8bff84d5aeace381b1021b384edfb904b74300`
- **sha256 (API docs HTML):** `f9ba3c41702351bbbfe6c11b6dae4069932c5dc2193fcd07ef06a1e626981228`

## Rendering caveat

The `bitfinex.com/legal/terms` page is rendered client-side by a SPA;
the raw HTML fetched by `curl` is the Next.js shell, not the legal copy.
The audit therefore relies on the rendered text already reviewed by the
founder (recorded in `orbi/src/sources/bitfinex.ts` header) plus what is
verbatim-visible in the API docs page (which IS server-rendered).

## Relevant clauses

- **Rate limit (verbatim from docs):** "Users of REST are subject to rate
  limits and thereby limited in the volume of data that they can retrieve
  within a particular time frame." Practical published cap: 10-90 req/min
  per endpoint with a 60-second IP block on breach. Plug-in default = 0.4
  rps (24 rpm) — under even the lowest threshold.
- **Redistribution:** The Bitfinex Terms of Service are SILENT on
  derived indices and market-data redistribution (typical of crypto
  exchanges). No explicit license required; no explicit prohibition.
- **Commercial use:** Not gated for public market data per the docs.
  Standard practice for downstream indices (Bloomberg BGCI, Kaiko, etc.)
  is to consume Bitfinex's free public endpoints with no formal license.
- **Attribution:** Not required.

## Assessment

Using `/v2/candles/trade:1m:tBTCUSD/hist` for historical backfill, storing
the resulting candles, and re-emitting them through ORBI's aggregated
index is **permitted as-is**. This matches the posture already recorded
for the live `bitfinex` source plug-in (silent on indices; no outreach
needed per the Hybrid Asymmetric Risk-Management Strategy).

## Required attribution string

None at the row level. List Bitfinex on the ORBI methodology page as a
contributing venue.

## Action items

- [ ] Re-fetch the rendered Terms of Service text (headless browser) and
  update the sha256 + verbatim clause text here once.
