#!/usr/bin/env python3
"""ORBI-D daily roll-up  -  composite 1d close from 1m ORBI-M rows.

For each (source_currency, target_currency, source_authority='ORBI') pair,
compute yesterday's UTC daily close as the LAST 1m bucket of the UTC day.

INSERT with:
  granularity='1d'
  product='ORBI-D'
  composite=true
  composite_via='1m-day-close'
  source_authority='ORBI'
  provenance='composite-replay'  (only value in allowed enum that fits this rollup)
  tier='C-composite'
  status='CONFIRMED'

Idempotent via ON CONFLICT DO NOTHING on the unique key.

Continuity check at end: if the latest written ORBI-D row is more
than 36 hours behind now(), Signal alert. Brittleness-fix pattern:
alert failures NEVER cascade to data-work failures.

Designed to run daily at 00:15 UTC via systemd timer, with Persistent=true
so a missed run catches up. Accepts an optional --date YYYY-MM-DD arg
to force roll-up for a specific UTC day (used for backfill/smoke test).
"""
import argparse, os, subprocess, sys
from datetime import datetime, timezone, timedelta

PSQL = "/opt/bb-support/scripts/psql-orbi"
SIGNAL = "/opt/bb-support/scripts/orbi-signal-alert.sh"
LOG = "/var/log/orbi/orbi-d-daily-rollup.log"


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def signal_alert(subject, body=""):
    try:
        subprocess.run([SIGNAL, subject, body], timeout=15)
    except Exception as e:
        log(f"signal-alert failed (suppressed): {e}")


def rollup_day(target_day):
    """Roll up the given UTC date string YYYY-MM-DD. Returns rows inserted."""
    day_start = f"{target_day} 00:00:00+00"
    next_day = (datetime.strptime(target_day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                + timedelta(days=1)).strftime("%Y-%m-%d 00:00:00+00")
    bucket_ts = f"{target_day} 00:00:00+00"

    sql = f"""
WITH last_minute AS (
    SELECT DISTINCT ON (source_currency, target_currency)
        source_currency,
        target_currency,
        bucket_ts AS last_min_ts,
        rate
    FROM exchange_rates
    WHERE source_authority = 'ORBI'
      AND granularity     = '1m'
      AND product         = 'ORBI-M'
      AND bucket_ts >= '{day_start}'
      AND bucket_ts <  '{next_day}'
    ORDER BY source_currency, target_currency, bucket_ts DESC
)
INSERT INTO exchange_rates (
    source_currency, target_currency, bucket_ts, granularity, product,
    rate, tier, composite, composite_via, provider_count, status,
    fetched_at, computed_at, provenance, source_authority
)
SELECT
    source_currency, target_currency,
    '{bucket_ts}'::timestamptz,
    '1d', 'ORBI-D',
    rate, 'C-composite', true, '1m-day-close', 1, 'CONFIRMED',
    now(), now(), 'composite-replay', 'ORBI'
FROM last_minute
ON CONFLICT (source_currency, target_currency, bucket_ts, source_authority, granularity, product)
  DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at, provider_count = EXCLUDED.provider_count, fetched_at = EXCLUDED.fetched_at
RETURNING source_currency, target_currency;
"""
    r = subprocess.run([PSQL, "-At", "-q", "-F", "|", "-c", sql],
                       capture_output=True, text=True, timeout=480)
    if r.returncode != 0:
        log(f"rollup SQL FAIL for {target_day}: {r.stderr[:400]}")
        return -1
    stripped = r.stdout.strip()
    rows = [ln for ln in stripped.split("\n") if ln] if stripped else []
    return len(rows)


def continuity_check():
    """Alert if latest ORBI-D row is >36h behind now()."""
    try:
        sql = ("SELECT EXTRACT(EPOCH FROM (now() - MAX(bucket_ts)))::bigint "
               "FROM exchange_rates "
               "WHERE source_authority='ORBI' AND granularity='1d' AND product='ORBI-D';")
        r = subprocess.run([PSQL, "-At", "-c", sql],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0 or not r.stdout.strip():
            log(f"continuity probe failed (suppressed): {r.stderr[:200]}")
            return
        secs_behind = int(r.stdout.strip())
        hours = secs_behind / 3600.0
        log(f"continuity: latest ORBI-D is {hours:.1f}h behind now()")
        if secs_behind > 36 * 3600:
            signal_alert(
                "ORBI-D continuity FAIL",
                f"Latest ORBI-D row is {hours:.1f}h behind now() (>36h threshold).",
            )
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="UTC date YYYY-MM-DD to roll up (default: yesterday)")
    args = parser.parse_args()

    if args.date:
        target = args.date
    else:
        target = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

    log(f"=== ORBI-D rollup start for UTC day {target} ===")
    inserted = rollup_day(target)
    if inserted < 0:
        log("rollup FAILED")
        signal_alert("ORBI-D rollup FAILED", f"UTC day {target} rollup returned error.")
        sys.exit(1)
    log(f"=== ORBI-D rollup done: {inserted} rows inserted for {target} ===")
    continuity_check()


if __name__ == "__main__":
    main()
