# ORBI historical-backfill — operations runbook

What it does: imports historical 1-minute BTC OHLCV candles from one source
into `exchange_rates`, tagged with `provenance = 'historical-backfill'` so
they can be rolled back independently of the live forward-fill output.

Phase B.1 shipped Bitstamp via the cryptodatadownload.com CSV mirror.
Phase B.2 adds Kraken via the official Google Drive OHLCVT archive (7 BTC
pairs — the broadest single-source coverage in ORBI's Tier A roster).
Coinbase, Bitfinex, Mercado Bitcoin and Bitso land as B.3 / B.4.

---

## Prerequisites

1. Migration `005_add_provenance_column.sql` applied to PROD. Check with:
   ```sh
   psql -c "\d exchange_rates" | grep provenance
   ```
   If absent, founder applies via Supabase Management API before any real
   backfill run.

2. `/opt/bb-support/.env` contains `ORANGERAILS_PROD_ACCESS_TOKEN` and
   `ORANGERAILS_PROD_SUPABASE_URL`. Same vars the forward-fill cron uses.

3. Disk: `/tmp/orbi-backfill/` will hold one CSV per pair. The current
   Bitstamp BTC/USD bundle is ~25 MB / ~227k rows.

---

## Bitstamp mirror coverage (verified 2026-05-26)

| Pair    | Mirror URL                                                    | Granularity | Range (approx)        |
|---------|---------------------------------------------------------------|-------------|-----------------------|
| BTC/USD | https://www.cryptodatadownload.com/cdd/Bitstamp_BTCUSD_minute.csv | 1m          | rolling ~6 months     |
| BTC/EUR | https://www.cryptodatadownload.com/cdd/Bitstamp_BTCEUR_minute.csv | 1m          | rolling ~6 months     |
| BTC/GBP | (not available at 1m on the mirror — daily/hourly only)       | —           | —                     |

The mirror is rolling. For pre-mirror data we'll need the Bitstamp paged
OHLC API (`/api/v2/ohlc/{pair}/?step=60&start=<unix>&limit=1000`) looped
over the target window — fallback adapter lands in B.2 if/when needed.

For BTC/GBP at 1m we fall through to that paged API today. Not implemented
in Phase B.1. If you need GBP minute data now, file a follow-up — or use
Kraken (see below), which DOES have BTC/GBP at 1-minute granularity.

---

## Kraken bulk CSV (Phase B.2, verified 2026-05-26)

Kraken publishes a public Google Drive folder of quarterly ZIP archives
covering 1-minute OHLCVT for every Kraken-listed pair. This is ORBI's
broadest single-source pair coverage and our workhorse for the 2023+
historical window.

- Portal article: <https://support.kraken.com/articles/360047124832>
- Drive folder:   <https://drive.google.com/drive/folders/15RSlNuW_h0kVM8or8McOGOMfHeBFvFGI>

Files exposed at the portal on 2026-05-26: 13 quarterly ZIPs covering
Q1 2023 → Q1 2026. Each ZIP contains many CSVs, one per (pair, granularity)
— for example `XBTUSD_1.csv` is 1-minute XBT/USD. Files are header-less:
`unix,open,high,low,close,volume,trades`.

The portal article *copy* mentions "back to 2013" but the public folder
only hosts 2023+ at present. If older history is needed, file a follow-up
and we'll add a paged-API fallback in B.4 — DO NOT silently fall through
right now.

### Pair coverage at 1-minute granularity

| ORBI pair | Kraken symbol | CSV inside ZIP |
|-----------|---------------|----------------|
| BTC/USD   | XBTUSD        | XBTUSD_1.csv   |
| BTC/EUR   | XBTEUR        | XBTEUR_1.csv   |
| BTC/GBP   | XBTGBP        | XBTGBP_1.csv   |
| BTC/CAD   | XBTCAD        | XBTCAD_1.csv   |
| BTC/AUD   | XBTAUD        | XBTAUD_1.csv   |
| BTC/JPY   | XBTJPY        | XBTJPY_1.csv   |
| BTC/CHF   | XBTCHF        | XBTCHF_1.csv   |

Note Kraken uses `XBT` (the ISO-4217-compatible code) not `BTC` in its
symbols. The plug-in's CLI input is ORBI's canonical `BTC/X` notation;
mapping to `XBTX` is internal.

### How the plug-in works

1. Enumerates every quarter ZIP overlapping `[from, to)`.
2. For each quarter, fetches the ZIP from
   `https://drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`.
   (We go straight to drive.usercontent.google.com with `confirm=t` to skip
   the HTML interstitial Drive serves for files >100 MB on the
   `drive.google.com/uc` endpoint.)
3. Extracts JUST the per-pair `<XBTPAIR>_1.csv` from each ZIP via `unzip -p`
   into `/tmp/orbi-backfill/.kraken-extract-<year>-Q<q>/`.
4. Concatenates the per-quarter CSVs (in chronological order) into a single
   `/tmp/orbi-backfill/Kraken_<XBTPAIR>_1.csv` (header-less).
5. Stream-parses that file with a caller-supplied header
   `["unix","open","high","low","close","volume","trades"]` (csv-parser was
   extended to support header-less CSVs as part of B.2 — minimal diff).
6. Same downstream pipeline as Bitstamp: batched UPSERT with
   `provenance='historical-backfill'`, tier `B-single`, status `CONFIRMED`.

### Quarter ZIP file-ID map

The plug-in hardcodes the 13 file IDs Kraken currently publishes. If
Kraken ever rotates these (they're "Anyone with the link" shares), the
download will 404. To refresh:

```sh
curl -sL 'https://drive.google.com/drive/folders/15RSlNuW_h0kVM8or8McOGOMfHeBFvFGI' \
  -A 'Mozilla/5.0' > /tmp/kraken_drive.html
python3 -c "
import re
html=open('/tmp/kraken_drive.html').read()
for m in re.finditer(r'(Kraken_OHLCVT_Q[1-4]_20\d{2}\.zip)\\\\x22.*?drive\.google\.com\\\\?/file\\\\?/d\\\\?/([A-Za-z0-9_-]{20,})', html, re.S):
    print(m.group(1), m.group(2))
"
```

Update the `KRAKEN_DRIVE_FILE_IDS` map in
`scripts/historical-backfill/sources/kraken-csv.ts` and re-run.

### Run a Kraken backfill

```sh
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi

# 1) Dry-run a small recent window (downloads the latest quarter ZIP only).
bun run scripts/historical-backfill/orchestrator.ts \
  kraken BTC/USD 2026-01-10 2026-01-15 --dry-run

# 2) Real run for the same window (founder triggers — Phase B.2 ships
#    plug-in code; do NOT auto-run).
bun run scripts/historical-backfill/orchestrator.ts \
  kraken BTC/USD 2026-01-10 2026-01-15 \
  2>&1 | tee /tmp/orbi-backfill-kraken-btcusd.log

# 3) Multi-quarter run spanning all of 2025 for BTC/CAD.
bun run scripts/historical-backfill/orchestrator.ts \
  kraken BTC/CAD 2025-01-01 2026-01-01 \
  2>&1 | tee /tmp/orbi-backfill-kraken-btccad.log
```

`--resume` reuses already-downloaded ZIPs in `/tmp/orbi-backfill/` AND skips
minutes already recorded in
`/tmp/orbi-backfill-kraken-<XBTPAIR>.checkpoint.json`.

### Roll back

Same as Bitstamp — provenance scopes the delete:

```sql
DELETE FROM exchange_rates
WHERE provenance     = 'historical-backfill'
  AND source_currency = 'BTC'
  AND target_currency = 'USD'
  AND granularity     = '1m'
  AND product         = 'ORBI-M'
  AND bucket_ts >= '2026-01-10'
  AND bucket_ts <  '2026-01-15';
```

### Approximate runtime + data volume

Measured on bb-support, 2026-05-26 (1 Gbit residential link, NVMe disk):

| Window                | Quarters | ZIP download | Parse + dry-run | Rows           |
|-----------------------|----------|--------------|-----------------|----------------|
| BTC/USD 5 days (2026) | 1 (cached on 2nd run) | ~7 s         | ~1 s            | 7,197          |
| BTC/CAD 5 days (2026) | 1 (cached)            | 0 s          | 0.5 s           | 4,621          |

Extrapolations for full-year backfills (writes via Supabase Management API,
~500-row batches, ~50 ms/round-trip):

| Window            | Quarters | Est. ZIP download | Est. UPSERT runtime |
|-------------------|----------|-------------------|---------------------|
| BTC/USD 1 year    | 4        | ~30-60 s          | ~50-90 min          |
| BTC/USD 3 years   | 12       | ~3-5 min          | ~2.5-4.5 hours      |
| 7 pairs × 3 years | 12 (ZIPs shared) | ~3-5 min total | ~16-30 hours total |

Disk footprint: each quarter ZIP is 200-550 MB; if you don't trim
`/tmp/orbi-backfill/` between pairs, all 13 ZIPs together are ~4.5 GB.
The plug-in keeps the ZIPs (they're the expensive download) and only
extracts/concatenates the per-pair CSVs (~5-25 MB each).

### Things the founder should know before launching real Kraken backfills

1. The first run for any new quarter downloads a 200-550 MB ZIP. Subsequent
   pairs in the same quarter reuse the cached ZIP — so backfilling all 7
   pairs for a quarter is one download, not seven.
2. Some pairs launched mid-archive (e.g. BTC/AUD added Q3 2024). The
   plug-in treats "pair not in this quarter's ZIP" as "no rows for this
   quarter" rather than failing, so a multi-year range Just Works.
3. Pre-2023 data is NOT on the portal as of 2026-05-26. Date ranges before
   2023-01-01 will fail with "empty quarter range" or "no rows extracted".
4. The forward-fill cron and Bitstamp backfill keep running unaffected —
   UPSERT conflicts on overlap are no-ops (the live cron's row wins on
   newer `computed_at`).
5. Kraken's Drive file IDs are stable but not guaranteed. If a download
   returns <10 MB, the plug-in throws with the message "Drive may have
   served an interstitial. Verify the file ID map." — see refresh
   instructions above.

---

## Run a backfill

```sh
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi

# 1) Dry-run a small window first — proves the file downloads + parses cleanly,
#    no DB writes happen.
bun run scripts/historical-backfill/orchestrator.ts \
  bitstamp BTC/USD 2026-05-20 2026-05-25 --dry-run

# 2) When the dry-run looks right, run for real:
bun run scripts/historical-backfill/orchestrator.ts \
  bitstamp BTC/USD 2026-05-20 2026-05-25 \
  2>&1 | tee /tmp/orbi-backfill-bitstamp.log
```

`--dry-run` parses + counts + samples but never touches the DB.

`--resume` reuses the previously downloaded CSV and skips minutes already
recorded in `/tmp/orbi-backfill-bitstamp-BTCUSD.checkpoint.json`.

### Monitor

```sh
tail -f /tmp/orbi-backfill-bitstamp.log
```

Progress lines log every 10,000 rows parsed.

### Resume after a crash

```sh
bun run scripts/historical-backfill/orchestrator.ts \
  bitstamp BTC/USD 2026-05-20 2026-05-25 --resume \
  2>&1 | tee -a /tmp/orbi-backfill-bitstamp.log
```

The checkpoint file at `/tmp/orbi-backfill-bitstamp-BTCUSD.checkpoint.json`
records the last successfully-written bucket. Resume skips any candle whose
`bucketTs <= lastCompletedBucketTs`. Re-running over already-written buckets
is also safe — the UPSERT is idempotent — but `--resume` avoids the wasted
network round-trips to Supabase.

### Roll back

Provenance lets you scope a delete to just this pipeline's output:

```sql
-- Roll back a Bitstamp BTC/USD backfill window:
DELETE FROM exchange_rates
WHERE provenance     = 'historical-backfill'
  AND source_currency = 'BTC'
  AND target_currency = 'USD'
  AND granularity     = '1m'
  AND product         = 'ORBI-M'
  AND bucket_ts >= '2026-05-20'
  AND bucket_ts <  '2026-05-25';
```

Forward-fill rows (`provenance='forward-fill'`) are untouched. Reconciler
upgrades (`provenance='reconciler-upgrade'`) are untouched.

---

## What lands in the database

Every row from a Phase-B.1 backfill is:

- `provenance     = 'historical-backfill'`
- `status         = 'CONFIRMED'`
- `tier           = 'B-single'` (one source contributed)
- `provider_count = 1`
- `composite      = FALSE`

The Phase B.5 re-resolve pass will later combine multiple historical sources
per minute and upgrade tier where possible (B-single → B or A). That's a
separate work item. Do not edit `resolve.ts` or `forward-fill.ts` from this
runbook.

---

## Expected runtime and data volume

| Pair    | Rows on mirror | Approx run time (dry-run) | Approx run time (live UPSERT) |
|---------|----------------|---------------------------|-------------------------------|
| BTC/USD | ~227,000       | ~10 s                     | ~5-10 min                     |
| BTC/EUR | ~150,000       | ~7 s                      | ~3-6 min                      |

Live timing is dominated by Supabase Management API throughput. Batches are
500 rows, so a full BTC/USD bundle is ~454 UPSERT round-trips.

---

## Pre-launch sanity checklist

Before launching the first real (non-dry-run) backfill:

1. Migration 005 is live in PROD (see Prerequisites).
2. Dry-run completes cleanly with non-zero `parsed` and a sensible
   `first bucket` / `last bucket`.
3. Founder approval to write to `exchange_rates`. Phase B.1 plug-in
   ships with the explicit rule: **no real backfill without founder
   sign-off** — even a small one.
4. Forward-fill and reconciler crons keep running during the backfill.
   UPSERT conflicts are fine; the live cron's row wins (newer
   `computed_at`) for any overlap window.

---

## Phase B.3 + B.4 — paged-API sources (added 2026-05-26)

Four new source plug-ins extend ORBI's historical backfill ladder beyond
the B.1 mirror + B.2 quarterly archives. Each one walks the exchange's own
public OHLC endpoint page-by-page, requires NO authentication, and feeds
the same orchestrator pipeline.

| Source                  | Pairs                           | Endpoint                                                | Depth          |
|-------------------------|---------------------------------|---------------------------------------------------------|----------------|
| `bitstamp-paged`        | BTC/USD, BTC/EUR, BTC/GBP       | `/api/v2/ohlc/{pair}/?step=60&start=&limit=1000`        | back to 2011-08 (BTC/USD), 2017-12 (BTC/EUR), 2022-05 (BTC/GBP) |
| `bitfinex-paged`        | BTC/USD, BTC/EUR, BTC/GBP       | `/v2/candles/trade:1m:t{PAIR}/hist?start=&end=&limit=10000&sort=1` | back to 2013-04 (BTC/USD), 2018-11 (BTC/GBP), 2019-06 (BTC/EUR) |
| `bitso-paged`           | BTC/MXN, BTC/ARS, BTC/USD, BTC/BRL (winding down) | `/v3/ohlc?book=&time_bucket=60&start=&end=` (ms!)   | back to ~2014 (BTC/MXN), ~2021 (BTC/ARS) |
| `mercado-bitcoin-paged` | BTC/BRL, BTC/USDT, BTC/USDC     | `/api/v4/candles?symbol=BASE-QUOTE&resolution=1m&from=&to=` | back to v4 launch (~2020) for 1m granularity |

Bitso has BTC/BRL listed but is winding down the BRL desk per their
announcement. Dry-run before any production run; if zero rows, drop from
`supportedPairs`.

### Pagination behavior

- **bitstamp-paged**: 1000 candles per page (~16.6 h). Advance by
  `last_timestamp + 60s`. Terminates on empty `data.ohlc`.
- **bitfinex-paged**: 10000 candles per page (~166 h). `sort=1` for
  ascending. Advance by `last_mts + 60_000`. Terminates on empty array.
- **bitso-paged**: ~1 day per call empirically (no documented page-size
  cap). Walks in 24h windows; advances by `last_bucket_start_time + 60_000`.
  Terminates on empty payload.
- **mercado-bitcoin-paged**: returns up to ~1440 buckets per call (1 day
  of 1-minute data). Walks in 24h windows; advances by `last_t + 60`.
  Terminates on empty `t`.

### Rate limits and cadence

| Source                  | Documented cap        | Plug-in default   |
|-------------------------|-----------------------|-------------------|
| `bitstamp-paged`        | 8000 req / 10 min (~13 rps) | 6 rps, burst 6 |
| `bitfinex-paged`        | 10-90 req/min varies; 60s IP block on breach | 0.4 rps, burst 2 |
| `bitso-paged`           | 60 req/min public (1 rps); HTTP 420 + 60s lockout on breach | 0.8 rps, burst 2 |
| `mercado-bitcoin-paged` | Not formally documented; CF 429 if aggressive | 1 rps, burst 2 |

### Dry-run smoke (2026-05-20 to 2026-05-25, captured 2026-05-26)

| Source                  | Pair    | Rows parsed | Duration |
|-------------------------|---------|-------------|----------|
| `bitstamp-paged`        | BTC/USD | 7,200       | ~2.2 s   |
| `bitfinex-paged`        | BTC/USD | 7,198       | ~0.5 s   |
| `bitso-paged`           | BTC/MXN | 7,200       | ~3.9 s   |
| `mercado-bitcoin-paged` | BTC/BRL | 5,060       | ~3.1 s   |

5 days x 1440 minutes/day = 7200 minutes. bitstamp / bitso hit that exactly
because they carry-the-last-quote for zero-volume buckets; bitfinex and
mercado only emit buckets when trades occurred (gaps in low-liquidity
minutes).

### Runtime estimates for real (DB-write) backfills

Live timing is dominated by the Supabase Management API throughput
(~50 ms/round-trip per 500-row batch). API-side fetch time for these
paged sources is the much smaller term.

| Source                  | Window     | Pages | Est. fetch | Est. UPSERT |
|-------------------------|------------|-------|------------|-------------|
| `bitstamp-paged` BTC/USD | 1 year    | ~525  | ~90 s      | ~50-90 min  |
| `bitstamp-paged` BTC/USD | 10 years (deep history) | ~5260 | ~15 min | ~9-15 h |
| `bitfinex-paged` BTC/USD | 1 year    | ~53   | ~2 min     | ~50-90 min  |
| `bitfinex-paged` BTC/USD | 10 years  | ~530  | ~22 min    | ~9-15 h     |
| `bitso-paged` BTC/MXN    | 1 year    | ~365  | ~8 min     | ~25-45 min  |
| `bitso-paged` BTC/MXN    | 5 years   | ~1825 | ~38 min    | ~2-4 h      |
| `mercado-bitcoin-paged` BTC/BRL | 1 year | ~365 | ~6 min  | ~15-25 min  |

### Run a paged-API backfill

```sh
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi

# Dry-run a recent 5-day window for each source
bun run scripts/historical-backfill/orchestrator.ts bitstamp-paged BTC/USD 2026-05-20 2026-05-25 --dry-run
bun run scripts/historical-backfill/orchestrator.ts bitfinex-paged BTC/USD 2026-05-20 2026-05-25 --dry-run
bun run scripts/historical-backfill/orchestrator.ts bitso-paged BTC/MXN 2026-05-20 2026-05-25 --dry-run
bun run scripts/historical-backfill/orchestrator.ts mercado-bitcoin-paged BTC/BRL 2026-05-20 2026-05-25 --dry-run

# Real run (founder triggers; phase B.3/B.4 ships plug-in code only)
bun run scripts/historical-backfill/orchestrator.ts bitstamp-paged BTC/USD 2018-01-01 2026-05-25 \
  2>&1 | tee /tmp/orbi-backfill-bitstamp-paged-btcusd.log
```

`--resume` is supported via the standard checkpoint file
(`/tmp/orbi-backfill-<source>-<paircode>.checkpoint.json`).

### Per-source ToS audit trail

Each paged-API plug-in has a companion `*.tos-notes.md` file under
`scripts/historical-backfill/sources/`:

- `bitstamp-paged-api.tos-notes.md`
- `bitfinex-paged-api.tos-notes.md`
- `bitso-paged-api.tos-notes.md`
- `mercado-bitcoin-paged-api.tos-notes.md`

These files document URL, fetch date, sha256 of the fetched ToS body,
relevant clauses, assessment, and any required attribution. They are the
audit trail Agent A's `orbi/scripts/tos-compliance/` system consumes.

### Roll back any paged-API backfill

Same provenance-scoped delete as the B.1/B.2 sources:

```sql
DELETE FROM exchange_rates
WHERE provenance     = 'historical-backfill'
  AND source_currency = 'BTC'
  AND target_currency = 'USD'
  AND granularity     = '1m'
  AND product         = 'ORBI-M'
  AND bucket_ts >= '<from>'
  AND bucket_ts <  '<to>';
```
