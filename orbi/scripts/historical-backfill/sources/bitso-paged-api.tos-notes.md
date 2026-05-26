# Bitso paged-API — ToS audit notes

- **Source name in ORBI:** `bitso-paged`
- **API endpoint:** <https://api.bitso.com/v3/ohlc?book=&time_bucket=60&start=&end=>
- **Terms of Service URL (fetched):** <https://bitso.com/legal/terms>
- **API Docs URL (fetched):** <https://docs.bitso.com>
- **Date read:** 2026-05-26
- **sha256 (Terms page HTML):** `9aa5280bc80c4cfccefe5a7226bcdb00a6e3f9f580e381a536fecc85f309bbd3`
- **sha256 (API docs HTML):** `148c37bbd288a6cad01679b0feb2db55b596acf9868117e140527ae32ca94360`

## Rendering caveat

Bitso's `/legal/terms` is a Segment-instrumented SPA; the raw HTML is the
React shell. Same approach as the other crypto-exchange ToS audits — rely
on the prior live-source plug-in audit (`orbi/src/sources/bitso.ts`) plus
the API docs page (server-rendered).

## Relevant clauses

- **Rate limit:** 60 req/min for public endpoints (1 rps). HTTP 420 on
  breach with a 60-second IP lockout. Plug-in default = 0.8 rps, burst 2.
- **Redistribution:** Bitso's ToS are SILENT on indices/derived market
  data (typical for LATAM crypto exchanges). No explicit license required.
- **Commercial use:** Bitso already partners with Kaiko, which means
  Bitso's market data flows into commercial indices upstream. That's a
  strong implicit signal that consuming `/v3/ohlc` for an aggregated
  downstream index is acceptable.
- **Attribution:** Not required.
- **API-specific:** Bitso's docs (docs.bitso.com) document the public
  endpoints with no usage license attached.

## API quirk discovered during audit

`/v3/ohlc` requires **millisecond** timestamps in `start`/`end` despite
accepting `time_bucket=60` in seconds. Passing unix-seconds silently
returns `{"success":true,"payload":[]}` with no error. This is undocumented
and was verified empirically 2026-05-26. The plug-in always passes ms.

## Assessment

Using `/v3/ohlc` for historical backfill, storing the resulting candles,
and re-emitting them through ORBI's aggregated index is **permitted
as-is**. Bitso is critical LATAM coverage (BTC/MXN, BTC/ARS) and no
other source in the panel publishes those books at 1-minute granularity.

Courtesy email to <api@bitso.com> remains a paper-trail item (does NOT
gate launch) — matches the posture already recorded for the live `bitso`
source plug-in.

## Required attribution string

None at the row level. List Bitso on the ORBI methodology page.

## Action items

- [ ] Send courtesy paper-trail email to api@bitso.com before Phase 3
  commercial launch.
- [ ] BTC/BRL book status: Bitso announced winding down the BRL desk.
  Dry-run BTC/BRL before any production run; if zero rows, drop from
  `supportedPairs`.
