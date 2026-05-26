# ORBI gap reconciler — operations runbook

## What it does (plain English)

ORBI publishes a Bitcoin rate every minute for thirteen currencies. The
forward-fill script makes ONE attempt at each minute. If a source's API was
slow or the pair didn't trade that exact second, the minute lands with a
lower tier than it could have — for example, Tier B-single (one source) when
Tier A (three or more sources) was achievable.

The reconciler runs five minutes behind forward-fill, looks back at the last
hour, and re-attempts any minute where the published rate sits below the
best tier reachable for that pair. If the second attempt brings in more
sources, the row is overwritten (UPSERT). If not, the original stays. The
reconciler never downgrades a rate.

## Which pairs the reconciler can upgrade

| Pair    | Max historical tier | Sources used                                          |
|---------|---------------------|-------------------------------------------------------|
| BTC/USD | A                   | kraken, bitstamp, bitfinex, coinbase_exchange         |
| BTC/EUR | A                   | kraken, bitstamp, coinbase_exchange                   |
| BTC/GBP | A                   | kraken, bitstamp, coinbase_exchange                   |
| BTC/BRL | B                   | bitso, mercado_bitcoin                                |

Skipped (no historical upgrade possible):

| Pair                   | Reason                                                              |
|------------------------|---------------------------------------------------------------------|
| BTC/CAD AUD JPY CHF    | Only kraken supports historical fetch; mempool.space is current-only |
| BTC/MXN ARS            | Bitso is the only source — single-source by design                  |
| BTC/INR TRY ZAR        | Composite pairs (Tier C); resolved through a different code path    |

mempool.space's `/api/v1/prices` returns the CURRENT BTC price only — there
is no historical-by-timestamp endpoint. Using it for past minutes would
stamp the now-price onto an old bucket, so the reconciler deliberately
leaves it out.

## Install the cron entry

See `scripts/RECONCILER_CRON.md` for the exact crontab line. Two minutes
of work; the reconciler is purely additive — disabling it never affects
forward-fill.

## Read the log

```bash
tail -F /tmp/orbi-reconciler.log
```

Each run prints one summary line:

```
Summary: scanned=511 attempted=87 upgraded=0 unchanged=87 failed=0 skipped=424 (11482ms)
```

- **scanned** — rows in the last hour that came back from Postgres
- **attempted** — rows below their max historical tier, re-resolved
- **upgraded** — actual UPSERTs (second attempt brought in more sources)
- **unchanged** — re-resolve returned same-or-fewer sources; no write
- **failed** — re-resolve threw; row left as-is
- **skipped** — rows already at max tier OR in a skip-list pair

Healthy state: `failed=0`, occasional `upgraded` events when forward-fill
catches a hiccup. Persistent `failed > 0` for one currency means an
exchange API is misbehaving — check the line-level `FAIL BTC/<x>` entries
above the summary.

## Manual one-shot

```bash
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi

# read-only — show what WOULD be upgraded, write nothing
bun run scripts/reconcile-gaps.ts --dry-run

# scan a shorter window
bun run scripts/reconcile-gaps.ts --lookback 15

# real run (same as cron)
bun run scripts/reconcile-gaps.ts
```

The script is idempotent — running it twice in a row is safe.

## Rollback

Two options, in order of preference:

1. **Disable cron** — comment out the `*/5` line in `crontab -e`. Forward-
   fill keeps running. No data corruption possible.

2. **Revert the commit** — if a reconciler-specific bug is suspected, the
   reconciler lives entirely in `scripts/reconcile-gaps.ts` plus its test
   file. Nothing in `src/` was modified for this feature, so reverting the
   reconciler commit leaves the rest of ORBI untouched.

Recovery from a bad UPSERT (hypothetical — never observed): the audit row
in `exchange_rate_resolutions` records the reconciler's contribution with
prefix `[reconciler upgrade]` in `median_calculation`. Filter on that
prefix to identify reconciler-written rates if needed.

## Why this exists — example incident

2026-05-26: BTC/ARS went silent from 18:08 → 19:00 UTC because the Bitso
ARS feed stalled. BTC/GBP only reached Tier A on ~25% of minutes because
mempool.space was inconsistent. Forward-fill had no second-chance
mechanism. The reconciler closes that loop.
