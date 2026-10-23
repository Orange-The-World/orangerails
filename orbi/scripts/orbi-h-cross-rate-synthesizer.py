#!/usr/bin/env python3
"""
Phase H  -  ORBI cross-rate daily synthesizer.

Purpose
-------
Densify ORBI BTC/<fiat> daily coverage (granularity=1d, product=ORBI-D,
source_authority=ORBI) for any day where:

  (a) MEMPOOL_SPACE upstream is only weekly (pre-2022 USD, pre-2024 most pairs)
      so ORBI-D for that pair currently echoes the weekly cadence; AND
  (b) we already hold the inputs to construct a daily-grain value:
        BTC/USD daily close  = last Bitstamp minute bucket of the UTC day
                                (BITSTAMP minute rows already in DB)
        USD/<fiat> daily     = existing daily ORBI-D rows
                                (sources: ECB / FED / BOC / etc., already loaded)

Per the audit-finding resolution (orbi-coverage-validation-matrix-2026-05-29
Rtd5hleTAW) MEMPOOL_SPACE rows stay honest at upstream granularity  -  we do
NOT touch them. Instead we write synthetic daily rows into the ORBI
namespace, marked composite=true with composite_via documenting the build
recipe, so downstream consumers see a continuous daily series while
provenance remains auditable.

Pairs covered
-------------
  BTC/USD   -  direct from Bitstamp daily close.
  BTC/EUR, BTC/GBP, BTC/JPY, BTC/CAD, BTC/AUD, BTC/CHF
            -  BTC/USD synthesized × USD/<fiat> daily.

Strategy
--------
Walk every UTC day from each pair's effective start (the LATER of Bitstamp
BTC/USD start 2011-08-18 and that pair's USD/<fiat> start) through today,
and INSERT ... ON CONFLICT DO NOTHING into exchange_rates. The unique key
(source_currency, target_currency, bucket_ts, granularity, product,
source_authority) means existing rows (mempool-echo or otherwise) are left
intact and we only fill the gaps.

Idempotent. Safe to re-run; safe to run as a systemd timer for ongoing
daily forward-fill if upstream weekly lag persists.
"""
import os
import subprocess
import sys
import time
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal, getcontext

# Provided by orbi_continuity module  -  used for end-of-run audit.
sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_end_of_run

getcontext().prec = 28

LOG = "/var/log/orbi/orbi-h-cross-rate-synthesizer.log"
PSQL = "/opt/bb-support/scripts/psql-orbi"
SIGNAL = "/opt/bb-support/scripts/orbi-signal-alert.sh"

# (target_currency, USD/<fiat> source_authority used for FX cross-rate lookup).
# USD is direct (no cross-rate). Order matches the audit matrix §5.
PAIRS = [
    ("USD", None),
    ("EUR", "ECB"),
    ("GBP", "ORBI"),
    ("JPY", "ORBI"),
    ("CAD", "ORBI"),
    ("AUD", "ORBI"),
    ("CHF", "ORBI"),
]

# Bitstamp BTC/USD minute data starts here.
BITSTAMP_START = date(2011, 8, 18)


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
        log(f"signal-alert FAILED (suppressed): {e}")


def psql(sql, timeout=600):
    # Use stdin for the SQL  -  large INSERT batches blow past ARG_MAX on -c.
    r = subprocess.run([PSQL, "-At", "-F", "|"],
                       input=sql, capture_output=True, text=True,
                       timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[:400]}")
    return r.stdout


def fetch_btc_usd_daily_close():
    """Return {date: Decimal} for BTC/USD daily close from Bitstamp minute rows.

    Daily close = rate at MAX(bucket_ts) within each UTC day. Single index
    scan via DISTINCT ON.
    """
    sql = (
        "SELECT (bucket_ts AT TIME ZONE 'UTC')::date AS d, rate "
        "FROM ( "
        "  SELECT DISTINCT ON ((bucket_ts AT TIME ZONE 'UTC')::date) "
        "         bucket_ts, rate "
        "  FROM exchange_rates "
        "  WHERE source_authority='BITSTAMP' "
        "    AND source_currency='BTC' AND target_currency='USD' "
        "    AND granularity='1m' "
        "  ORDER BY (bucket_ts AT TIME ZONE 'UTC')::date, bucket_ts DESC "
        ") s ORDER BY d;"
    )
    out = psql(sql, timeout=900)
    rows = {}
    for line in out.strip().split("\n"):
        if not line:
            continue
        d_str, rate_str = line.split("|")
        rows[date.fromisoformat(d_str)] = Decimal(rate_str)
    return rows


def fetch_usd_fiat_daily(target_currency, source_authority):
    """Return {date: Decimal} for USD/<fiat> daily close rows."""
    sql = (
        "SELECT (bucket_ts AT TIME ZONE 'UTC')::date AS d, rate "
        "FROM exchange_rates "
        f"WHERE source_authority='{source_authority}' "
        f"  AND source_currency='USD' AND target_currency='{target_currency}' "
        "  AND granularity='1d' AND product='ORBI-D' "
        "ORDER BY bucket_ts;"
    )
    out = psql(sql, timeout=300)
    rows = {}
    for line in out.strip().split("\n"):
        if not line:
            continue
        d_str, rate_str = line.split("|")
        rows[date.fromisoformat(d_str)] = Decimal(rate_str)
    return rows


def fetch_existing_orbi_d_days(target_currency):
    """Set of dates where ORBI-D BTC/<fiat> already exists in ORBI namespace."""
    sql = (
        "SELECT (bucket_ts AT TIME ZONE 'UTC')::date "
        "FROM exchange_rates "
        f"WHERE source_authority='ORBI' "
        f"  AND source_currency='BTC' AND target_currency='{target_currency}' "
        "  AND granularity='1d' AND product='ORBI-D';"
    )
    out = psql(sql, timeout=300)
    return {date.fromisoformat(d) for d in out.strip().split("\n") if d}


def insert_rows(target_currency, rows, composite_via):
    """Bulk INSERT ... ON CONFLICT DO NOTHING.

    rows: list of (date, Decimal rate).
    Returns number of rows actually inserted (we count via the difference
    in row count before/after to avoid trusting INSERT's reported count
    in batched mode).
    """
    if not rows:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat(timespec='seconds')
    # Build VALUES list. Keep batches modest (5000) to stay under any
    # statement size limit.
    inserted = 0
    BATCH = 1000
    cv_escaped = composite_via.replace("'", "''")
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        values = []
        for d, rate in chunk:
            ts = f"{d.isoformat()} 00:00:00+00"
            values.append(
                f"('BTC','{target_currency}','{ts}','1d','ORBI-D',"
                f"{rate:.8f},'C-composite',true,'{cv_escaped}',1,'CONFIRMED',"
                f"'{now_iso}','{now_iso}','historical-backfill','ORBI')"
            )
        sql = (
            "INSERT INTO exchange_rates "
            "(source_currency,target_currency,bucket_ts,granularity,product,"
            " rate,tier,composite,composite_via,provider_count,status,"
            " fetched_at,computed_at,provenance,source_authority) VALUES "
            + ",".join(values)
            + " ON CONFLICT (source_currency,target_currency,bucket_ts,"
              "granularity,product,source_authority) DO NOTHING "
              "RETURNING 1;"
        )
        out = psql(sql, timeout=300)
        inserted += len([l for l in out.strip().split("\n") if l])
    return inserted


def run():
    log("=== ORBI cross-rate daily synthesizer START ===")
    today = datetime.now(timezone.utc).date()

    log("Loading Bitstamp BTC/USD daily closes from minute series...")
    btc_usd = fetch_btc_usd_daily_close()
    log(f"  loaded {len(btc_usd)} BTC/USD daily closes "
        f"({min(btc_usd)} → {max(btc_usd)})")

    summary = {}
    for target, fx_auth in PAIRS:
        log(f"--- BTC/{target} ---")
        existing = fetch_existing_orbi_d_days(target)
        log(f"  existing ORBI-D rows: {len(existing)}")

        rows_to_insert = []
        if target == "USD":
            composite_via = ("Bitstamp BTC/USD daily close "
                             "(last 1m bucket of UTC day)")
            for d, rate in btc_usd.items():
                if d in existing:
                    continue
                if d > today:
                    continue
                rows_to_insert.append((d, rate.quantize(Decimal("0.00000001"))))
        else:
            fx = fetch_usd_fiat_daily(target, fx_auth)
            log(f"  loaded {len(fx)} USD/{target} daily rates "
                f"(authority={fx_auth})")
            composite_via = (
                f"BTC/USD × USD/{target} cross-rate "
                f"(Bitstamp BTC/USD daily close × {fx_auth} USD/{target} daily)"
            )
            for d, btc_rate in btc_usd.items():
                if d in existing or d > today:
                    continue
                fx_rate = fx.get(d)
                if fx_rate is None:
                    # FX market closed (weekend / holiday). Walk back up to
                    # 5 business days for the most recent published rate.
                    for back in range(1, 6):
                        fx_rate = fx.get(d - timedelta(days=back))
                        if fx_rate is not None:
                            break
                    if fx_rate is None:
                        continue
                synth = (btc_rate * fx_rate).quantize(Decimal("0.00000001"))
                rows_to_insert.append((d, synth))

        log(f"  building {len(rows_to_insert)} synthetic rows...")
        n = insert_rows(target, rows_to_insert, composite_via)
        log(f"  inserted {n} rows into ORBI namespace")
        summary[target] = n

    # End-of-run continuity audit per loader pattern.
    for target, _ in PAIRS:
        continuity_check_end_of_run("ORBI", "BTC", target)

    log("=== synthesizer DONE ===")
    log("Summary: " + ", ".join(f"BTC/{k}={v}" for k, v in summary.items()))
    return summary


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        log(f"FATAL: {e}")
        signal_alert("orbi-h-cross-rate-synthesizer FAILED", str(e)[:500])
        raise
