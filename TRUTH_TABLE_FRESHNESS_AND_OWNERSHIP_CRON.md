# ORBI Truth-Table Freshness and Ownership Drift Probes

Scripts in `scripts/ops/` that watch the twelve truth tables in
`supabase-db/orange_world`. Built out of OR-T1370: the existing
`orbi-staleness-probe.sh` only ever watched `public.exchange_rates`, so the
public dataset froze for 93 days with nothing telling us. See the design
spec for the full reasoning: *Truth-table freshness and ownership-drift
alarm: design and build spec* on wiki.orangerails.dev.

---

## scripts/ops/orbi-truthtable-freshness-probe.sh

Enumerates every RLS-on table in the `public` schema from `pg_class` at run
time (never a hardcoded or pattern-filtered list) and alarms when one has
gone frozen, when a loader has never succeeded, or when the enumerated
table count shrinks between runs.

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | OK -- every enumerated table is within its derived threshold | no action |
| 1 | ALARM -- a table is frozen, a loader has never succeeded (`max(fetched_at)` is NULL), or the enumerated table count shrank, **and the page was delivered** | page on-call |
| 2 | ERROR -- could not reach the DB, a query failed, a table's threshold could not be derived (fewer than two distinct timestamps), a table has no timestamp column, `ORBI_ALERT_SCRIPT` unset or not executable, `ORBI_FRESHNESS_STATE_FILE` unset, **or the page could not be delivered** | page on-call (higher priority) |

Exit 1 always means someone was actually told. If the alert script exits
non-zero the probe falls through to 2, so an undelivered ALARM can never be
read as a delivered one, and a host with no usable alert path refuses to
start rather than reporting a healthy probe that can page nobody.

A table that cannot be evaluated (missing timestamp column, fewer than two
distinct timestamps) is never silently skipped: it is exit 2, naming the
table, because "I could not check" must be loud, not folded into a pass.

### Per-table threshold

`max(4 hours, 3 x p90 inter-fetch gap)`, capped at 14 days, derived at run
time from each table's own last 60 distinct `fetched_at` (or
`last_success_at`) values. p90 rather than max, so one historical outage in
the sample does not raise the bar above the next outage. 3x rather than 2x,
so a daily loader slipping a few hours is not noise. The 4 hour floor stops
an hourly table paging on one missed run; the 14 day cap stops a table with
genuinely sparse history from becoming unalarmable. A frozen table does not
corrupt its own threshold: gaps are measured between existing timestamps,
which stop advancing, so the historical cadence is preserved.

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ORBI_PROBE_DSN` | yes (or `DATABASE_URL`) | -- | postgres DSN |
| `DATABASE_URL` | fallback | -- | used if `ORBI_PROBE_DSN` unset |
| `ORBI_ALERT_SCRIPT` | yes | -- | absolute path to the host's existing alert script, called as `<script> <level> <body>`. Supplied by the systemd unit environment so no host path lives in this repo. The probe exits 2 before querying anything if it is unset, missing, or not executable. |
| `ORBI_FRESHNESS_STATE_FILE` | yes | -- | absolute path to a small file the probe uses to remember the last enumerated table count, so a shrinking list is loud. Supplied by the unit environment for the same reason as the alert script. |
| `ORBI_MIN_THRESHOLD_SECONDS` | no | 14400 (4h) | floor for the derived threshold |
| `ORBI_MAX_THRESHOLD_SECONDS` | no | 1209600 (14d) | cap for the derived threshold |
| `ORBI_GAP_MULTIPLIER` | no | 3 | multiplier on the p90 inter-fetch gap |

---

## scripts/ops/orbi-ownership-drift-probe.sh

Catches the mechanism behind the 93-day freeze directly: a restore silently
changed eight table owners, which turned on RLS enforcement for the loader
role. OR-T1202 restores the owners; this probe is what makes that durable,
because ownership is an invisible attribute a future restore can strip
again without a sound. It is meaningful today and does not wait on
OR-T1202.

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | OK -- every RLS-on public table is owned by `ORBI_EXPECTED_OWNER` and none forces RLS on its own owner | no action |
| 1 | ALARM -- at least one table has drifted, **and the page was delivered** | page on-call |
| 2 | ERROR -- could not reach the DB, the query failed, `ORBI_ALERT_SCRIPT` unset or not executable, **or the page could not be delivered** | page on-call (higher priority) |

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ORBI_PROBE_DSN` | yes (or `DATABASE_URL`) | -- | postgres DSN |
| `DATABASE_URL` | fallback | -- | used if `ORBI_PROBE_DSN` unset |
| `ORBI_ALERT_SCRIPT` | yes | -- | same contract as the freshness probe above |
| `ORBI_EXPECTED_OWNER` | no | `orbi_writer` | the role every RLS-on public table must be owned by |

---

## systemd install set (both probes)

Both probes reuse the existing generic `orbi-probe-failed@.service` handler
(`scripts/ops/orbi-probe-failed.sh`), so it only needs to be installed once
even if the staleness probe is not present on this host. Order matters: the
handler must exist before either probe unit is enabled, or `OnFailure=`
resolves to nothing and a probe crash pages nobody.

| # | File in repo | Install to |
|---|--------------|------------|
| 1 | `scripts/ops/orbi-probe-failed.sh` | `/usr/local/bin/orbi-probe-failed.sh` (chmod +x) |
| 2 | `systemd/orbi-probe-failed@.service` | `/etc/systemd/system/orbi-probe-failed@.service` |
| 3 | `scripts/ops/orbi-truthtable-freshness-probe.sh` | `/usr/local/bin/orbi-truthtable-freshness-probe.sh` (chmod +x) |
| 4 | `systemd/orbi-truthtable-freshness-probe.service` | `/etc/systemd/system/orbi-truthtable-freshness-probe.service` |
| 5 | `systemd/orbi-truthtable-freshness-probe.timer` | `/etc/systemd/system/orbi-truthtable-freshness-probe.timer` |
| 6 | `scripts/ops/orbi-ownership-drift-probe.sh` | `/usr/local/bin/orbi-ownership-drift-probe.sh` (chmod +x) |
| 7 | `systemd/orbi-ownership-drift-probe.service` | `/etc/systemd/system/orbi-ownership-drift-probe.service` |
| 8 | `systemd/orbi-ownership-drift-probe.timer` | `/etc/systemd/system/orbi-ownership-drift-probe.timer` |

Both probe units share one env file, `/etc/orbi/orbi-truthtable-probes.env`,
carrying `ORBI_PROBE_DSN`, `ORBI_ALERT_SCRIPT`, and (for the freshness probe)
`ORBI_FRESHNESS_STATE_FILE`. The freshness probe's state file must live on
a path that persists across runs (not `/tmp`) and be writable by the unit's
user.

Then `systemctl daemon-reload` and enable both timers:

```
systemctl enable --now orbi-truthtable-freshness-probe.timer
systemctl enable --now orbi-ownership-drift-probe.timer
```

**Not in this change:** installing these units on the host. That is a
follow-on once this PR is approved and merged, and it needs a hand with
host write; see the PR for the handoff.

### Acceptance: both checks must be watched going red

A check nobody has seen fail is not a check. Three forced failures, all
required, output pasted on the ticket that shipped this doc:

1. **Freshness red.** On a scratch copy, push a table's newest `fetched_at`
   back beyond its derived threshold (or restore a snapshot from before the
   loader last ran). Confirm exit 1 and the page arriving.
2. **Ownership red.** On a scratch copy, `ALTER TABLE ... OWNER TO postgres`
   on one table. Confirm the alarm names that table and exit 1.
3. **Cannot check.** Point the DSN at a dead port, and separately rename the
   alert script. Both must exit 2, loudly, and must never read as a pass.

The CI job `orbi-truthtable-probe-test` in
`.github/workflows/orbi-truthtable-probe-test.yml` runs every pull request
that touches these scripts and proves each exit-code path has been watched
going red, the same pattern `orbi-probe-test.yml` uses for the staleness
probe.
