# ORBI reconciler — cron install (with crash alerting)

Updated 2026-05-26: the reconciler now runs through a wrapper that pages the
founder via Signal on any non-zero exit. The forward-fill writer is now under
systemd (see `README.md` in this directory) and should be **removed** from
crontab if it's still there.

## Canonical crontab line (ubuntu user on bb-support)

Open the crontab:

```bash
crontab -e
```

The block should look like this:

```cron
# forward-fill is managed by systemd (orbi-forward-fill.service) — DO NOT
# add a cron entry for it here.

# every 5 minutes (offset 30s): re-attempt under-tier rates in the last hour.
# The wrapper pages the founder on non-zero exit via signal-cli.
*/5 * * * * sleep 30 && /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/alert-on-failure.sh
```

The 30-second offset avoids racing the on-the-minute forward-fill writer.

## What changed vs. the previous line

Previous:

```cron
*/5 * * * * sleep 30 && cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi && bun run scripts/reconcile-gaps.ts >> /tmp/orbi-reconciler.log 2>&1
```

The wrapper still appends stdout/stderr to `/tmp/orbi-reconciler.log`, so log
tailing keeps working. It additionally fires a Signal alert to the founder
(`+17057123215`) when the reconciler exits non-zero.

## Verify it's running

```bash
crontab -l | grep alert-on-failure
tail -F /tmp/orbi-reconciler.log
```

A healthy run still looks like:

```
[2026-05-26T19:15:25.755Z] reconcile-gaps lookback=60min
  Scanned 511 rows in last 60 min
  Summary: scanned=511 attempted=87 upgraded=0 unchanged=87 failed=0 skipped=424 (11482ms)
```

## Disable alerting only

Swap the line back to the previous form (no wrapper). Reconciler keeps running
but crashes are silent again.

## Disable reconciler entirely

Comment out (`#`) the line. Forward-fill (systemd) keeps running on its own —
the reconciler is purely additive.
