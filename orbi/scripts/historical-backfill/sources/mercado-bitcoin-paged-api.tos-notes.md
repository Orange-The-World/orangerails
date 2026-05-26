# Mercado Bitcoin paged-API — ToS audit notes

- **Source name in ORBI:** `mercado-bitcoin-paged`
- **API endpoint:** <https://api.mercadobitcoin.net/api/v4/candles?symbol=BTC-BRL&resolution=1m&from=&to=>
- **Terms of Use URL (fetched):** <https://www.mercadobitcoin.com.br/termos-de-uso>
- **API Docs URL:** <https://api.mercadobitcoin.net/api/v4/docs>
- **Date read:** 2026-05-26
- **sha256 (Terms page HTML):** `debd75b7ce1f4ccfd5a494d8fcf32afa6074b9a20559c83db45f5136697c2f88`
- **sha256 (API docs HTML):** `dbcdef9390bdc21c7a41c80de05bd799575c9b8406cf7ef0a00fb01761368b3f`

## Bot-protection caveat

Both URLs are behind Cloudflare's "Attention Required!" challenge when
fetched without a real browser session. The hashes are of the challenge
pages, not the substantive legal text. The audit therefore relies on the
posture already recorded in `orbi/src/sources/mercado-bitcoin.ts` (live
source plug-in header), which was reviewed by the founder before that
plug-in was added to the panel.

## Relevant clauses (per prior audit recorded in live source plug-in)

- **Rate limit:** Not formally documented. Mercado Bitcoin's Cloudflare
  reverse proxy begins 429-ing aggressive callers. Plug-in default = 1 rps,
  burst 2 — conservative.
- **Redistribution:** Public market data is EXPLICITLY carved out of the
  ToS's Confidential Information clause (per the prior founder-reviewed
  audit). No "no-indices" clause. There is a "no commercial services"
  friction clause which is **mitigated** by (a) courtesy notification and
  (b) attribution.
- **Commercial use:** A courtesy notification to
  <contato@mercadobitcoin.com.br> is the documented mitigation — it does
  NOT gate launch but creates a paper trail.
- **Attribution:** Recommended (not strictly required at the row level).

## API quirks discovered during audit

The `/api/v4/candles` symbol parameter MUST be hyphenated `BASE-QUOTE`
(e.g. `BTC-BRL`). Sending `BTCBRL` or `BTC/BRL` returns
`{"code":"PUBLIC_DATA|LIST_CANDLES|SYMBOL_IS_INVALID"}`. The legacy
`/api/{base}/day-summary/YYYY/MM/DD/` endpoint takes the base alone
(e.g. `BTC`) and returns daily summaries — usable as a 1-day-granularity
fallback for years pre-2020 where v4 may be sparse.

## Assessment

Using `/api/v4/candles` for historical backfill, storing the resulting
candles, and re-emitting them through ORBI's aggregated index is
**permitted as-is** under the public-market-data carve-out. Mercado
Bitcoin is critical Brazilian coverage (BTC/BRL is the flagship
benchmark book for Brazil).

## Required attribution string

None at the row level. List Mercado Bitcoin on the ORBI methodology page
as a contributing venue. Courtesy notification email is a separate
paper-trail action.

## Action items

- [ ] Send courtesy email to contato@mercadobitcoin.com.br before Phase 3
  commercial launch (matches the posture from the live `mercado-bitcoin`
  plug-in).
- [ ] Re-fetch ToS through a browser session and update the sha256 +
  verbatim clause text here once.
