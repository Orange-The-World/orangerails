# ORBI reconciler — cron install

Add the second line below to the `ubuntu` crontab on bb-support
(`crontab -e`). The first line is the existing forward-fill schedule, shown
here for context — leave it alone.

```cron
# every minute: publish a fresh ORBI-M rate
* * * * * cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi && bun run scripts/forward-fill.ts >> /tmp/orbi-forward-fill.log 2>&1

# every 5 minutes (offset 30s): re-attempt under-tier rates in the last hour
*/5 * * * * sleep 30 && cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi && bun run scripts/reconcile-gaps.ts >> /tmp/orbi-reconciler.log 2>&1
```

The 30-second offset avoids racing the on-the-minute forward-fill writer.

## Verify it's running

```bash
crontab -l | grep reconcile-gaps
tail -F /tmp/orbi-reconciler.log
```

A healthy run looks like:

```
[2026-05-26T19:15:25.755Z] reconcile-gaps lookback=60min
  Scanned 511 rows in last 60 min
  Summary: scanned=511 attempted=87 upgraded=0 unchanged=87 failed=0 skipped=424 (11482ms)
```

## Disable

Comment out (`#`) the reconciler line in `crontab -e`. Forward-fill keeps
running on its own — the reconciler is purely additive.
