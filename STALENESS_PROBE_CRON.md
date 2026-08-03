# ORBI Staleness Probe and Forward-Fill Liveness Check

Scripts in `scripts/ops/` that guard the ORBI 1-minute rate feed.

---

## scripts/ops/orbi-staleness-probe.sh

Queries `max(bucket_ts)` from `public.exchange_rates WHERE granularity = '1m'`
and exits with the appropriate severity code.

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | OK -- newest row is within threshold | no action |
| 1 | STALE -- newest row is older than `STALE_THRESHOLD_MINUTES` (default 10) | page on-call |
| 2 | ERROR -- could not reach DB, query failed, or table empty | page on-call (higher priority) |

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ORBI_PROBE_DSN` | yes (or `DATABASE_URL`) | -- | postgres DSN |
| `DATABASE_URL` | fallback | -- | used if `ORBI_PROBE_DSN` unset |
| `STALE_THRESHOLD_MINUTES` | no | 10 | minutes before exit 1 fires |
| `ZULIP_ALARM_URL` | no | -- | alarm webhook; alarm skipped if unset |
| `ZULIP_ALARM_KEY` | no | -- | bearer token for alarm webhook |
| `ZULIP_ALARM_TO` | no | `Delivery\|orbi-staleness-probe` | stream:topic |

### Cron setup (on the maintainer host)

```
*/2 * * * * ORBI_PROBE_DSN="<dsn>" /opt/orbi/scripts/orbi-staleness-probe.sh >> /var/log/orbi-staleness-probe.log 2>&1
```

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
| Fresh data | staleness probe | postgres fixture, `bucket_ts = now() - 1 minute` | 0 |
| Stale data | staleness probe | postgres fixture, `bucket_ts = now() - 20 minutes` | 1 |
| Bad DSN | staleness probe | `ORBI_PROBE_DSN=postgres://nobody:x@unreachable:5432/db` | 2 |
| Service active | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=active` | 0 |
| Service inactive | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=inactive` | 1 |
| Service failed | liveness | `SYSTEMCTL_BIN=mock-systemctl.sh`, `MOCK_STATE=failed` | 1 |
