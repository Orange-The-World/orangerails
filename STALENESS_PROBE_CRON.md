# ORBI Staleness/Density Probe and Forward-Fill Liveness Check

Scripts in `scripts/ops/` that guard the ORBI 1-minute rate feed.

---

## scripts/ops/orbi-staleness-probe.sh

Runs two independent checks against confirmed 1-minute rows in
`public.exchange_rates`:

1. The BTC/USD age check compares the newest `bucket_ts` with
   `STALE_THRESHOLD_MINUTES`.
2. The per-pair density check counts distinct minute buckets in the trailing
   `DENSITY_WINDOW_MINUTES`. A pair is active when it has a confirmed 1-minute
   bucket within `DENSITY_PAIR_LOOKBACK_DAYS`, so a pair with zero buckets in
   the density window stays visible. The shipped floor is 30 of 60 buckets.

The existing five-minute timer evaluates the trailing hourly window every five
minutes. This is separate from the daily 30-day gap audit: the 30-day value here
only defines the active pair set; it is not the density measurement window.

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | OK -- newest BTC/USD row is within its age threshold and every active pair meets the density floor | no action |
| 1 | DEGRADED -- the age or density threshold failed **and the page was delivered** | page on-call |
| 2 | ERROR -- could not reach DB, query failed, table empty, density configuration is invalid, `ORBI_ALERT_SCRIPT` is unset or unusable, **or the page could not be delivered** | page on-call (higher priority) |

Exit 1 always means someone was actually told. If the alert script exits
non-zero the probe falls through to 2, so an undelivered STALE can never be
read as a delivered one, and a host with no usable alert path refuses to start
rather than reporting a healthy probe that can page nobody.

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ORBI_PROBE_DSN` | yes (or `DATABASE_URL`) | -- | postgres DSN |
| `DATABASE_URL` | fallback | -- | used if `ORBI_PROBE_DSN` unset |
| `STALE_THRESHOLD_MINUTES` | no | 90 | BTC/USD age in minutes before exit 1 fires |
| `DENSITY_WINDOW_MINUTES` | no | 60 | trailing window used for every active pair |
| `DENSITY_MIN_BUCKETS` | no | 30 | minimum distinct minute buckets required per active pair; must not exceed the window size |
| `DENSITY_PAIR_LOOKBACK_DAYS` | no | 30 | a pair with any confirmed 1-minute bucket in this lookback remains active, including when its density-window count is zero |
| `ORBI_ALERT_SCRIPT` | yes | -- | absolute path to the host's existing alert script, called as `<script> <level> <body>`. Supplied by the systemd unit environment so no host path lives in this repo. The probe exits 2 before querying anything if it is unset, missing, or not executable. |

### Cron setup (on the maintainer host)

```
*/2 * * * * ORBI_PROBE_DSN="<dsn>" ORBI_ALERT_SCRIPT="<absolute path to the host alert script>" /opt/orbi/scripts/orbi-staleness-probe.sh >> /var/log/orbi-staleness-probe.log 2>&1
```

### systemd install set (preferred over cron)

Install all five files. Order matters: the handler must exist before the probe
unit is enabled, or `OnFailure=` resolves to nothing and a probe crash pages
nobody.

| # | File in repo | Install to |
|---|--------------|------------|
| 1 | `scripts/ops/orbi-probe-failed.sh` | `/usr/local/bin/orbi-probe-failed.sh` (chmod +x) |
| 2 | `systemd/orbi-probe-failed@.service` | `/etc/systemd/system/orbi-probe-failed@.service` |
| 3 | `scripts/ops/orbi-staleness-probe.sh` | `/usr/local/bin/orbi-staleness-probe.sh` (chmod +x) |
| 4 | `systemd/orbi-staleness-probe.service` | `/etc/systemd/system/orbi-staleness-probe.service` |
| 5 | `systemd/orbi-staleness-probe.timer` | `/etc/systemd/system/orbi-staleness-probe.timer` |

The probe env lives at `/etc/orbi/orbi-staleness-probe.env` and is read by both
the probe unit and the handler, so the alarm webhook is configured once.

Then `systemctl daemon-reload` and `systemctl enable --now orbi-staleness-probe.timer`.

### Acceptance: all three tests must be watched going red

A probe nobody has seen fail is not a probe. None of these is optional.

1. **Age alarm path.** Run the probe once with `STALE_THRESHOLD_MINUTES=0` and
   confirm the message actually arrives in the destination topic. The unit
   going red in the journal is not the test; the message landing is.
2. **Density alarm path.** In a controlled production-observation window,
   force a test pair below `DENSITY_MIN_BUCKETS` while BTC/USD remains fresh.
   Run the probe and confirm exit 1 plus a delivered message that names the
   pair and observed bucket count. Restore the test fixture afterwards. A log
   line alone does not satisfy this test.
3. **OnFailure path.** Rename `/usr/local/bin/orbi-staleness-probe.sh`, start
   the unit, and confirm a message arrives naming the failed unit. Restore the
   script afterwards. This proves the backstop fires when the probe cannot
   report for itself.

If the handler exits 3, the alarm transport is not configured on that host and
none of the alert-delivery tests above can pass: fix the env file before
reading anything as green.

---

## scripts/ops/orbi-forward-fill-liveness.sh

Calls `systemctl is-active orbi-forward-fill.service` and exits on any
state other than `active`.

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | service is `active` | no action |
| 1 | service is in any other state (`inactive`, `failed`, etc.) | page on-call |

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `SERVICE` | no | `orbi-forward-fill.service` | unit to check |
| `SYSTEMCTL_BIN` | no | `systemctl` | override for testing |
| `ZULIP_ALARM_URL` | no | -- | alarm webhook |
| `ZULIP_ALARM_KEY` | no | -- | bearer token |
| `ZULIP_ALARM_TO` | no | `Delivery\|orbi-forward-fill-liveness` | stream:topic |

### Cron setup (on the maintainer host)

```
*/2 * * * * /opt/orbi/scripts/orbi-forward-fill-liveness.sh >> /var/log/orbi-liveness.log 2>&1
```

---

## CI test matrix

The CI job `orbi-probe-test` in `.github/workflows/orbi-probe-test.yml` runs
every pull request that touches these scripts and proves each exit-code path
has been watched going red.

| Step | Script | Setup | Expected exit |
|------|--------|-------|---------------|
| Fresh data | staleness probe | 60 BTC/USD buckets and exactly 30 TST/USD buckets | 0 |
| Stale data | staleness probe | postgres fixture, `bucket_ts = now() - 20 minutes` | 1 |
| Bad DSN | staleness probe | `ORBI_PROBE_DSN=postgres://nobody:x@unreachable:5432/db` | 2 |
| Alert path unset | staleness probe | fresh data, `ORBI_ALERT_SCRIPT=""` | 2 |
| Alert path not executable | staleness probe | fresh data, `ORBI_ALERT_SCRIPT` points at a missing file | 2 |
| Page undeliverable | staleness probe | stale data, alert stub exits 1 | 2 |
| Pair below hourly density floor | staleness probe | fresh BTC/USD; TST/USD has 29 of 30 required buckets; ZRO/USD has zero | 1 |
| Density page undeliverable | staleness probe | under-dense pairs, alert stub exits 1 | 2 |
| Invalid density configuration | staleness probe | minimum 61 exceeds 60-minute window | 2 |
| Service active | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=active` | 0 |
| Service inactive | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=inactive` | 1 |
| Service failed | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=failed` | 1 |
