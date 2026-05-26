# ORBI central-bank backfill — operations runbook

What this does: imports daily reference rates from sovereign central banks
into `exchange_rates`, tagged with `source_authority` so they coexist with
our ORBI VW-median rates for the same (pair, date) without overwriting them.

Why it matters: Mexican (Banxico FIX), Brazilian (BCB PTAX) and Canadian
(Bank of Canada FXUSDCAD) tax authorities legally require the central bank's
published rate, not a market rate, for converting foreign-currency
transactions. Customers in those jurisdictions cannot use a market rate like
ORBI VW-median for tax reporting and IFRS use. Storing the central-bank
authority rate alongside ORBI lets us serve both queries from the same
table.

Phase D.1 ships three sources, Phase D.2 adds one more:

| Source            | Pair    | Authority code | Date range available | Phase |
|-------------------|---------|----------------|----------------------|-------|
| Banxico           | USD/MXN | `BANXICO`      | ~1993-01-04 onward   | D.1   |
| BCB (PTAX)        | USD/BRL | `BCB`          | 1984-11-28 onward    | D.1   |
| Bank of Canada    | USD/CAD | `BOC`          | 2017-01-03 onward    | D.1   |
| Bank of England   | USD/GBP | `BOE`          | ~1975 onward (XUDLGBD) | D.2 |

Phase D.2 sources NOT yet shipped (see `DEFERRED_SOURCES.md`):

- Reserve Bank of Australia (`RBA`) - blocked by Akamai bot protection from server IPs.
- Swiss National Bank (`SNB`) - no no-auth daily JSON cube; only annual + monthly.
- Bank of Japan (`BOJ`) - form-based scraping w/ Shift_JIS encoding; founder action required.

---

## Prerequisites

1. Migration `006_multi_authority.sql` applied to PROD. Verify the column +
   new unique constraint exist on `exchange_rates`:
   `source_authority` column present, `uq_rates_pair_bucket_authority`
   constraint replacing the old `uq_rates_pair_bucket`.

   If absent, founder applies via the Supabase Management API. See the
   migration file for the coordination notes — forward-fill and the
   historical-backfill batch writer use ON CONFLICT against the OLD unique
   key, so those writers must be updated before the new constraint goes
   live. (Out of scope for Phase D.1.)

2. `BANXICO_API_TOKEN` in `/opt/bb-support/.env` (Banxico only). Register
   for a free token at:
   https://www.banxico.org.mx/SieAPIRest/service/v1/token

   BCB and Bank of Canada are unauthenticated — no token needed.

3. `ORANGERAILS_PROD_ACCESS_TOKEN` and `ORANGERAILS_PROD_SUPABASE_URL` in
   `/opt/bb-support/.env`. Same vars the forward-fill and historical-backfill
   pipelines use.

---

## Run a backfill

```sh
cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi

# 1) Dry-run a recent 7-day window — proves the upstream API works and
#    parsing is clean. No DB writes.
bun run scripts/central-banks/orchestrator.ts bcb 2026-05-19 2026-05-26 --dry-run
bun run scripts/central-banks/orchestrator.ts boc 2026-05-19 2026-05-26 --dry-run
bun run scripts/central-banks/orchestrator.ts banxico 2026-05-19 2026-05-26 --dry-run

# 2) Run the full historical backfill (real writes). Founder approval
#    required before any non-dry-run invocation.
bun run scripts/central-banks/orchestrator.ts banxico 1993-01-01 2026-05-26 \
  2>&1 | tee /tmp/orbi-cb-banxico.log

bun run scripts/central-banks/orchestrator.ts bcb 1999-01-01 2026-05-26 \
  2>&1 | tee /tmp/orbi-cb-bcb.log

bun run scripts/central-banks/orchestrator.ts boc 2017-01-01 2026-05-26 \
  2>&1 | tee /tmp/orbi-cb-boc.log

# Bank of England (Phase D.2 — USD/GBP, XUDLGBD series back to ~1975).
bun run scripts/central-banks/orchestrator.ts boe 2026-05-19 2026-05-26 --dry-run
bun run scripts/central-banks/orchestrator.ts boe 1975-01-01 2026-05-26 \
  2>&1 | tee /tmp/orbi-cb-boe.log
```

`--resume` picks up from the last completed bucket recorded at
`/tmp/orbi-backfill-{authority}-{pair}.checkpoint.json`. Idempotent UPSERT
makes re-running safe regardless.

---

## What lands in the database

Every row from a Phase-D.1 backfill is:

- `source_authority = BANXICO | BCB | BOC` (per source)
- `provenance       = 'historical-backfill'`
- `status           = 'CONFIRMED'`
- `tier             = 'B-single'`
- `provider_count   = 1`
- `granularity      = '1d'`
- `product          = 'ORBI-D-authority'`
- `composite        = FALSE`

The `ORBI-D-authority` product code is distinct from `ORBI-D` (the daily
VW-median) so the calculate engine does not accidentally pull these into a
VW-median input set.

---

## Roll back

Each authority can be rolled back independently. Provenance scopes the
delete so no ORBI/forward-fill/reconciler rows are touched.

```sql
-- Roll back the full Banxico backfill:
DELETE FROM exchange_rates
WHERE source_authority = 'BANXICO'
  AND provenance       = 'historical-backfill'
  AND source_currency  = 'USD'
  AND target_currency  = 'MXN'
  AND product          = 'ORBI-D-authority';

-- Roll back BCB:
DELETE FROM exchange_rates
WHERE source_authority = 'BCB'
  AND provenance       = 'historical-backfill'
  AND source_currency  = 'USD'
  AND target_currency  = 'BRL'
  AND product          = 'ORBI-D-authority';

-- Roll back Bank of Canada:
DELETE FROM exchange_rates
WHERE source_authority = 'BOC'
  AND provenance       = 'historical-backfill'
  AND source_currency  = 'USD'
  AND target_currency  = 'CAD'
  AND product          = 'ORBI-D-authority';
```

Scope by date range with `AND bucket_ts >= '...' AND bucket_ts < '...'`
if you only want to roll back a window.

---

## Expected runtime and data volume

| Source          | Approx rows (full history) | Dry-run | Live UPSERT |
|-----------------|----------------------------|---------|-------------|
| Banxico (1993→) | ~8,300 business days       | ~5 s    | ~30-60 s    |
| BCB (1999→)     | ~6,800 business days       | ~10 s   | ~30-60 s    |
| BoC (2017→)     | ~2,300 business days       | ~3 s    | ~10-20 s    |

These are tiny compared to BTC minute backfills (millions of rows). All
three full histories fit in well under an hour of live writes combined.

---

## Pre-launch sanity checklist

Before launching the first real (non-dry-run) backfill:

1. Migration 006 is live in PROD and the OLD constraint
   (`uq_rates_pair_bucket`) is gone, replaced by
   `uq_rates_pair_bucket_authority`.
2. Forward-fill and historical-backfill writers updated to include
   `source_authority` in their ON CONFLICT clause (handled by Phase A /
   Phase B.2 maintainers — NOT this runbook).
3. Dry-run for the same window completes cleanly with non-zero `parsed`
   and a sensible `first bucket` / `last bucket`.
4. Founder approval to write to `exchange_rates`.

---

## Follow-up: backdate Frankfurter rows to source_authority = 'ECB'

Frankfurter passes through ECB published reference rates. Existing
Frankfurter rows were imported before the `source_authority` column existed
and currently default to 'ORBI'. They are technically ECB-authoritative.

After migration 006 is applied, founder runs a one-off UPDATE to retag
those rows. Identify the exact set first (likely by `provider_count=1`
combined with the fiat pair list in `src/sources/frankfurter.ts`, or by
joining to `exchange_rate_resolutions.providers_succeeded`). This is
NOT part of migration 006 and NOT part of Phase D.1's scope — documented
here as a pending founder action.
