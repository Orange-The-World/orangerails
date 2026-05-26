# Bitstamp paged-API — ToS audit notes

- **Source name in ORBI:** `bitstamp-paged`
- **API endpoint:** <https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=60&start=&limit=>
- **Terms of Use URL (fetched):** <https://www.bitstamp.net/terms-of-use/>
- **API Terms URL (fetched):** <https://www.bitstamp.net/api/>
- **Date read:** 2026-05-26
- **sha256 (Terms of Use HTML, as fetched):** `d02032286070b4dd9d8fbd985a7bdca8af8edf52b89ff177db3bfcb2c8a9c43d`
- **sha256 (API page HTML, as fetched):** `c93b6f7a8e9ab2... (Imperva/Incapsula bot-protection JS was served instead of the rendered page; the audit relies on prior bitstamp.ts (live source) ToS analysis which was reviewed by the founder.)`

## Bot-protection caveat

Both the Terms of Use page and the API documentation are protected by
Imperva/Incapsula in a way that returns a JS-challenge stub to plain
`curl`. The hash above is of that stub, not the rendered legal copy. To
re-verify, fetch the same URLs from an actual browser session and update
this file.

The substantive ToS posture below is the one already recorded in
`orbi/src/sources/bitstamp.ts` (live source plug-in header comments), which
was reviewed by the founder before that plug-in was added to the panel.

## Relevant clauses (per the existing live-source audit)

- **Rate limit:** Bitstamp publishes 8000 requests per 10 minutes per IP
  (~13 rps). The plug-in uses 6 rps with burst 6 — comfortably below cap.
- **Redistribution:** Bitstamp's API Terms permit derived statistical
  works (such as indices) subject to a Data Licensing Agreement (DLA) for
  certain commercial uses. The free public API itself is OK for internal
  research and for non-commercial publication of derived indices.
- **Commercial use:** A DLA is required for commercial redistribution of
  the raw Bitstamp data feed. ORBI does NOT redistribute the raw feed; it
  re-emits an aggregated 1-minute volume-weighted median across multiple
  venues. The DLA email is deferred to the Phase 3 commercial trigger
  (when ORBI begins commercial licensing).
- **Attribution:** Not required for the index output. Recommended best
  practice: list Bitstamp in the ORBI methodology page as a contributing
  venue.

## Assessment

Using `/api/v2/ohlc/...` for historical backfill, storing the resulting
candles, and re-emitting them through the ORBI VW-median index is
**permitted as-is** for ORBI's current internal/research use. No
attribution string needs to be embedded in the per-row output. A DLA
conversation with Bitstamp's commercial team is the right step BEFORE
launching ORBI as a paid product, but not before.

## Required attribution string

None at the row level. Bitstamp listed alongside other contributing venues
on the ORBI methodology page is sufficient.

## Action items

- [ ] Re-fetch Terms of Use from a real browser session and update the
  sha256 hash + verbatim clause text here.
- [ ] Email DLA inquiry to Bitstamp's commercial team before ORBI
  commercial launch (Phase 3 trigger).
