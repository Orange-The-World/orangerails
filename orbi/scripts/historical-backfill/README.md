# ORBI historical-backfill — operations runbook

What it does: imports historical 1-minute BTC OHLCV candles from one source
into `exchange_rates`, tagged with `provenance = 'historical-backfill'` so
they can be rolled back independently of the live forward-fill output.

Phase B.1 ships one source: Bitstamp via the cryptodatadownload.com CSV mirror.
More sources (Kraken, Coinbase, Bitfinex, Mercado Bitcoin, Bitso) land as
B.2 / B.3 in follow-up PRs.

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
in Phase B.1. If you need GBP minute data now, file a follow-up.

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
