#!/usr/bin/env python3
"""
Phase H1  -  FRED INTERNATIONAL monetary aggregates loader → monetary_aggregates

Series (via FRED):
  ECBASSETSW       EU  ECB balance sheet (weekly)         → ECB_BALANCE_SHEET, EUR
  MABMM301JPM189S  JP  M3 (monthly, national currency)    → M3, JPY
  MABMM301CAM189S  CA  M3 (monthly, national currency)    → M3, CAD
  MANMM101AUM189S  AU  M1 (monthly, national currency)    → M1, AUD

source_authority='FRED' (data lineage via Federal Reserve Bank of St. Louis).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fred-international-monetary.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1

SERIES = [
    # (fred_id, aggregate, country, currency, cadence)
    ("ECBASSETSW",      "ECB_BALANCE_SHEET", "EU", "EUR", "weekly"),
    ("MABMM301JPM189S", "M3",                "JP", "JPY", "monthly"),
    ("MABMM301CAM189S", "M3",                "CA", "CAD", "monthly"),
    ("MANMM101AUM189S", "M1",                "AU", "AUD", "monthly"),
]


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    print(line, file=sys.stderr)
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def _fred_key():
    for line in open(ENV_PATH):
        if line.startswith("FRED_API_KEY="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v
    raise RuntimeError("FRED_API_KEY not in /opt/bb-support/.env")


def _signal_alert(subject, body=""):
    try:
        subprocess.run(["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body], timeout=15)
    except Exception:
        pass


def fetch_series(series_id, api_key):
    url = (f"https://api.stlouisfed.org/fred/series/observations"
           f"?series_id={series_id}&api_key={api_key}&file_type=json&observation_start=1900-01-01")
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            log(f"  {series_id} HTTP {e.code}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {series_id} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def _period_end_monthly(d):
    if d.month == 12:
        ny, nm = d.year + 1, 1
    else:
        ny, nm = d.year, d.month + 1
    return date(ny, nm, 1) - timedelta(days=1)


def build_rows(series_id, aggregate, country, currency, cadence, observations, fetched_at_iso):
    rows = []
    src_url = f"https://fred.stlouisfed.org/series/{series_id}"
    for o in observations:
        v = o.get("value")
        if not v or v == ".":
            continue
        try:
            val = Decimal(v)
        except Exception:
            continue
        if val <= 0:
            continue
        try:
            ds = datetime.strptime(o["date"], "%Y-%m-%d").date()
        except Exception:
            continue
        if cadence == "monthly":
            ps = ds
            pe = _period_end_monthly(ds)
            label = ds.strftime("%Y-%m")
        else:
            ps = ds
            pe = ds + timedelta(days=6)
            label = ds.strftime("Week of %Y-%m-%d")
        rows.append([
            country, aggregate, ps.isoformat(), pe.isoformat(), label,
            "", str(val), currency, "true", "FRED",
            src_url, series_id, "historical-backfill",
            fetched_at_iso, fetched_at_iso,
        ])
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, aggregate, period_start, period_end, period_label, "
            "release_date, value, currency, seasonally_adjusted, source_authority, "
            "source_url, source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_m (LIKE monetary_aggregates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_m ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO monetary_aggregates ({cols}) "
        f"SELECT {cols} FROM _stg_m ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_m;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def continuity_check_end_of_run():
    try:
        sql = (
            "SELECT country, aggregate, source_series_id, count(*) AS n, "
            "  min(period_start), max(period_start) "
            "FROM monetary_aggregates "
            "WHERE source_authority='FRED' AND source_series_id IN "
            "  ('ECBASSETSW','MABMM301JPM189S','MABMM301CAM189S','MANMM101AUM189S') "
            "GROUP BY 1,2,3 ORDER BY 1;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (international monetary):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== Phase H1 FRED international monetary loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand = 0
    for series_id, aggregate, country, currency, cadence in SERIES:
        log(f"[{series_id}] fetching ({aggregate}, {country}, {cadence}) ...")
        d = fetch_series(series_id, api_key)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations")
        rows = build_rows(series_id, aggregate, country, currency, cadence, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows")
            grand += n
        time.sleep(SLEEP_BETWEEN)
    log(f"=== done: {grand} rows across {len(SERIES)} series ===")
    continuity_check_end_of_run()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H1 FRED int'l monetary FAILED", str(e)[:200])
        sys.exit(1)
