# ORBI central-bank sources - deferred (Phase D.2)

Three sources from the Phase D.2 scope hit a blocker that prevents
shipping a working no-auth plug-in. They are deferred and need founder
action before code can land.

Validated 2026-05-26 from `ubuntu@100.94.106.84`.

---

## Reserve Bank of Australia (RBA) - blocked by Akamai

- Public CSVs exist at `https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv`
  and `https://www.rba.gov.au/statistics/tables/xls-hist/f11hist.xls`.
- Both return HTTP 403 (Akamai bot protection) from our bb-support IP
  regardless of `User-Agent` or `Referer` header. Same response with
  `Mozilla/5.0`, `Orange-Rails-ORBI/1.0`, and from a Chrome UA with
  `Referer: https://www.rba.gov.au/statistics/historical-data.html`.
- Browsers reach the same URLs without issue, so this is IP-class
  fingerprinting, not absolute rejection.

Founder options:

1. Run the backfill from a non-cloud IP (laptop) one-off and upload the
   CSV to bb-support, then have the plug-in read from a fixture path.
2. Front the request through a residential-IP proxy (e.g. founder's home
   IP, a paid proxy service).
3. Negotiate an allowlist via RBA's public-data contact form (slow).

Until that's resolved, RBA stays deferred.

---

## Swiss National Bank (SNB) - no no-auth daily JSON

- `https://data.snb.ch/api/cube/devkua/data/csv/en` returns ANNUAL averages
  (one row per `YYYY`).
- `https://data.snb.ch/api/cube/devkum/data/csv/en` returns MONTHLY rates
  (one row per `YYYY-MM`).
- We probed `devkud`, `devkut`, `devkuc`, `devkuw`, `devkudd`, `devkurr`,
  `rendoua`, etc. - all return `{"message":"Table <code> not found"}`.
- The SNB SPA's cube-listing endpoint (`/api/warehouse/cubes`) serves the
  Angular index HTML to direct GETs (it expects an in-browser fetch).
- SNB's daily reference rates are published as a PDF bulletin only;
  there is no documented no-auth JSON/CSV daily cube.

Founder options:

1. If MONTHLY granularity is acceptable for Swiss customers' tax/IFRS
   filings, ship `devkum` with `granularity='1m'`. (Need legal
   confirmation that monthly suffices for ToS-compliance use cases.)
2. Subscribe to SNB's data feed (if one exists) - investigate.
3. Use ECB-published CHF/USD daily as a proxy (Frankfurter already
   delivers this); the customer-facing trade-off is that the
   `source_authority` would be `ECB`, not `SNB`.

Until that's resolved, SNB stays deferred.

---

## Bank of Japan (BOJ) - Shift_JIS form scraping

- BOJ's published "Time-Series Data Search" at
  `https://www.stat-search.boj.or.jp/info/dload_en.html` is a form-based
  download requiring a session cookie + multi-step POST.
- Response pages are Shift_JIS encoded, not UTF-8 - non-trivial to parse
  in Node/Bun without an encoding shim.
- There is no documented REST/CSV pull endpoint for daily JPY/USD
  reference rates.

Founder options:

1. Use BOJ's daily reference rate page
   (`https://www3.boj.or.jp/market/en/menu.htm`) which exposes a static
   PDF/HTML. A scraper would need an HTML parser + Shift_JIS decoder.
2. Use the Ministry of Finance Japan TTM rate (Mizuho/MUFG publishes a
   public CSV) - but that's a commercial-bank rate, not BOJ.
3. Use ECB JPY/USD daily as a proxy (Frankfurter already delivers this);
   `source_authority` would be `ECB`, not `BOJ`.

Until that's resolved, BOJ stays deferred.

---

## What ships in Phase D.2

Only Bank of England (`BOE`) ships fully working. See main README.
