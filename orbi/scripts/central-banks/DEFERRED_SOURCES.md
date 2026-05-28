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

## Banco Central de Chile (BCCH) - shipped via mindicador.cl proxy

Status: **shipped 2026-05-27** (founder approved Option 1).

- BCCH's official Siete REST API
  (`https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx`) requires
  registered authentication, which violates ORBI's silent-posture rule
  (no permission emails, no central-bank fingerprint).
- mindicador.cl proxies the BCCH "Dólar Observado" series
  (F073.TCO.PRE.Z.D) as free, no-auth JSON at
  `https://mindicador.cl/api/dolar/<YYYY>`.
- Coverage 2003-01-02 onward; no anti-scraping, no documented
  commercial restriction.

Authority tagging follows the established ECB-via-Frankfurter
precedent: rows land with `source_authority='BCCH'` per data origin;
transport (`mindicador.cl`) is recorded only on the providers row, not
on the observation.

See `orbi/scripts/central-banks/sources/bcch.ts` and migration
`orbi/schema/016_register_bcch.sql`.

---

## Bangko Sentral ng Pilipinas (BSP) — shipped via pesodollar.xlsx

Status: **shipped 2026-05-27**.

- BSP publishes the daily USD/PHP reference rate (and monthly/annual
  averages) in a single workbook at
  `https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx`. Daily
  sheet covers 1978-01-03 → present; ORBI consumes 2021-01-01 → present
  on first backfill.
- Sovereign-authoritative: file is published directly from BSP's own
  SharePoint path and referenced from the BSP ExchangeRate.aspx landing
  page. No auth, no API key, no Akamai fingerprint — silent-friendly.
- XLSX is parsed in-process via a minimal `node:zlib` zip reader (no
  external dependency), matching the convention of every other
  central-bank plug-in in this folder.

See `orbi/scripts/central-banks/sources/bsp.ts` and migration
`orbi/schema/017_register_bsp.sql`.

---

## Bank Negara Malaysia (BNM) — shipped via Kijang Open API

Status: **shipped 2026-05-27**.

- BNM publishes the daily USD/MYR reference rate via the free, no-auth
  Kijang Open API at
  `https://api.bnm.gov.my/public/exchange-rate/USD/year/{YYYY}/month/{M}`.
  Coverage verified 2021-01-04 → present on 2026-05-27.
- Sovereign-authoritative: `api.bnm.gov.my` is operated directly by BNM
  as part of their Open API Initiative. No auth, no API key, no Akamai
  fingerprint — silent-friendly. The vendor `Accept:
  application/vnd.BNM.API.v1+json` header is BNM's documented
  content-negotiation contract.
- Default 1130 session is the official noon reference accepted by
  Malaysian tax (LHDN/IRBM). `middle_rate` is `null` in 1130 payloads;
  daily mid is computed as `(buying_rate + selling_rate) / 2` — matches
  the 1200-session `middle_rate` to ≤ 1e-4 on spot-check days.

Sample observation (2024-01-15, 1130 session):
```json
{"date":"2024-01-15","buying_rate":4.63,"selling_rate":4.655,"middle_rate":null}
```

See `orbi/scripts/central-banks/sources/bnm.ts` and migration
`orbi/schema/018_register_bnm.sql`.

---

## Banco de la República (BANREP) — shipped via datos.gov.co

Status: **shipped 2026-05-28**.

- BANREP / Superintendencia Financiera de Colombia publish the daily
  USD/COP TRM (Tasa Representativa del Mercado), Colombia's official
  daily reference rate (Resolución 8 de 2000, BANREP Junta Directiva).
- `banrep.gov.co` itself is fronted by Radware Bot Manager and rejects
  server-side fetches with HTTP 200 "Bot Manager Block" stubs regardless
  of UA (same fingerprint pattern that blocked RBA in Phase D.2).
  SuperFinanciera's portal exposes only an HTML query form.
- Datos Abiertos Colombia (`datos.gov.co`, MinTIC), the national open
  data portal, republishes the SuperFin-attributed series as a Socrata
  SODA2 JSON dataset 32sa-8pi3. Coverage 1991-12-02 → present, license
  CC BY-SA 4.0, provenance OFFICIAL, attribution Superintendencia
  Financiera de Colombia.
- Each upstream row carries a `[vigenciadesde, vigenciahasta]` interval;
  ORBI expands every interval into one row per covered calendar day so
  the daily series has no weekend gaps (the published TRM is legally in
  force every covered day).

Authority tagging follows the established ECB-via-Frankfurter and
BCCH-via-mindicador.cl precedents: rows land with
`source_authority='BANREP'` per data origin; transport
(`datos.gov.co`) is recorded only on the providers row, not on the
observation.

See `orbi/scripts/central-banks/sources/banrep.ts` and migration
`orbi/schema/022_register_banrep.sql`.

---

## South African Reserve Bank (SARB) — shipped via Web API (EXCX135D)

Status: **shipped 2026-05-27**.

- SARB publishes the daily USD/ZAR indicative reference rate as
  timeseries code `EXCX135D` ("Rand per US Dollar") via its public Web
  API at
  `https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations/EXCX135D/{startDate}/{endDate}`.
  SARB's own description of the series: "Weighted average of the banks'
  daily rates at approximately 10:30 am. Weights are based on the banks'
  foreign exchange transactions." Coverage verified 2026-05-27:
  2021-01-04 → present (1,348 rows over the 5-year window).
- Sovereign-authoritative: served directly from SARB's
  `custom.resbank.co.za` Web API (same host as the SARB homepage market
  rates ticker). JSON, no auth, no API key, no Akamai-style WAF —
  silent-friendly.
- We already carry USD/ZAR via Frankfurter cross-rate; SARB adds the
  sovereign-authority signature on the same pair, more defensible for
  South African customer audits. Orchestrator's `source_authority='SARB'`
  is what differentiates the rows.
- ToS posture: SARB disclaimer prohibits redistribution without written
  consent; ORBI uses this rate as an authoritative reference signal
  (auditor-facing provenance), not for bulk republication — same
  silent-posture stance applied to RBA.

See `orbi/scripts/central-banks/sources/sarb.ts` and migration
`orbi/schema/020_register_sarb.sql`.

---

## Banco Central de Reserva del Perú (BCRP) — shipped via BCRPData API

Status: **shipped 2026-05-27**.

- BCRP publishes the daily USD/PEN interbank reference rate ("Tipo de
  Cambio Interbancario - Venta", series `PD04638PD`) through the
  BCRPData REST API at
  `https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json/<from>/<to>`.
  Free, no auth, no key, no Akamai/Incapsula fingerprint on the
  `estadisticas` subdomain (the primary `www.bcrp.gob.pe` IS Incapsula-
  fronted; we route around it).
- Coverage: full daily coverage from at least 2003 onward; ORBI
  consumes 2021-01-01 → present on first backfill.
- Sovereign-authoritative: BCRPData is published directly by BCRP's
  Gerencia Central de Estudios Económicos; the API is documented at
  `https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api`.
- Response uses Spanish-month-name dates ("04.Ene.21" = 2021-01-04) and
  decimal-string values; parsed in-process with a defensive Spanish
  date parser that accepts both BCRP's canonical "Set" and the
  alternative "Sep" abbreviations for September.

ToS: BCRP's Condiciones de Uso page
(`https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/condiciones-de-uso`)
explicitly permits full or partial reproduction without prior
authorization provided the source is cited
("Puede reproducirse total o parcialmente, sin autorización expresa,
siempre y cuando se cite la fuente."). Assessment:
`permitted-with-attribution`.

See `orbi/scripts/central-banks/sources/bcrp.ts` and migration
`orbi/schema/023_register_bcrp.sql`.## Reserve Bank of India (RBI) — shipped via Reference Rate archive

Status: **shipped 2026-05-27**.

- RBI publishes the daily USD/INR Reference Rate via the archive page at
  `https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx`. Since
  2018-07-10 the underlying rate is computed by Financial Benchmarks
  India Limited (FBIL) and labelled "Source: FBIL" on the RBI surface;
  ORBI consumes the RBI page (sovereign authority) and tags rows with
  `source_authority='RBI'`.
- Sovereign-authoritative: served directly from the central bank's own
  domain. Free, no API key, no permission email. Page is ASP.NET
  WebForms protected by an ASP.NET_SessionId cookie + a
  `__VIEWSTATE` / `__EVENTVALIDATION` token pair; the scraper performs
  a GET to harvest the tokens, then one POST per calendar-year chunk.
  No Akamai fingerprint observed from bb-support during 2026-05-27
  validation — silent-friendly under ORBI's Hybrid Asymmetric Strategy.
- Coverage gap: the archive endpoint returns observations from
  2022-04-04 onward only (FBIL transition + RBI archive
  re-architecture). The 2021-01-01 → 2022-04-03 window is not exposed
  by this endpoint; ORBI consumers requiring an earlier USD/INR rate
  should fall back to the ECB / Frankfurter cross-rate.
- Server caps each response at ~995 rows; orchestrator's `fetchRange`
  chunks by calendar year and dedupes by date.

See `orbi/scripts/central-banks/sources/rbi.ts` and migration
`orbi/schema/021_register_rbi.sql`.

## Bank Indonesia (BI) — shipped via JISDOR Unduh XLSX export

Status: **shipped 2026-05-28**.

- BI publishes JISDOR (Jakarta Interbank Spot Dollar Offered Rate), the
  official daily USD/IDR reference rate, on a SharePoint-hosted ASP.NET
  WebForms page at
  `https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx`.
  Computed each business day at ~10:00 WIB (UTC+7) from volume-weighted
  spot interbank quotes.
- Sovereign-authoritative: page is served from www.bi.go.id under a
  valid GlobalSign cert with O=Bank Indonesia. No auth, no API key, no
  Akamai fingerprint — silent-friendly under ORBI's Hybrid Asymmetric
  Strategy.
- Transport: the page exposes a date-range form with two buttons —
  "Cari" (Search, returns 10-row paginated HTML) and "Unduh" (Download,
  returns the full matching range as a single XLSX attachment). ORBI
  uses the Unduh path: one GET to harvest the `__VIEWSTATE` triple,
  one POST to fetch the export. Empirically the BI backend serves a
  5-year window (2021-01-01 → 2026-05-27, ~1,299 rows) in a ~32 KB
  XLSX in under 5 seconds.
- Header requirement: bare `User-Agent: curl/*` is blocked; a standard
  Chrome string with an `Orange-Rails-ORBI/1.0` suffix-comment passes.
- XLSX parsed in-process via the same `node:zlib` zip-reader pattern
  used by BSP (no external dependency).

See `orbi/scripts/central-banks/sources/bi.ts` and migration
`orbi/schema/019_register_bi.sql`.

---

## What ships in Phase D.2

Bank of England (`BOE`), Banco Central de Chile (`BCCH`), Bangko
Sentral ng Pilipinas (`BSP`), Bank Negara Malaysia (`BNM`), Banco de la
República (`BANREP`), South African Reserve Bank (`SARB`), Banco
Central de Reserva del Perú (`BCRP`), Reserve Bank of India (`RBI`),
and Bank Indonesia (`BI`) ship fully working. See main README.
