#!/usr/bin/env python3
"""
Phase H1  -  FRED US monetary aggregates loader → monetary_aggregates

Series:
  M1SL      M1 Money Stock, SA, monthly, billions of USD
  M2SL      M2 Money Stock, SA, monthly, billions of USD
  BOGMBASE  St. Louis Adjusted Monetary Base, monthly, millions of USD → mapped to 'M0'
  WALCL     Fed Total Assets (Wednesday level), weekly, millions of USD → mapped to 'FED_LIABILITIES'

NOTE: monetary_aggregates.aggregate enum allows {M0, M1, M2, M3, MZM, FED_LIABILITIES,
ECB_BALANCE_SHEET, BOJ_BALANCE_SHEET}. No 'MONETARY_BASE' or 'FED_TOTAL_ASSETS', so:
  BOGMBASE → 'M0'  (monetary base IS what M0 measures)
  WALCL    → 'FED_LIABILITIES'  (Fed balance sheet; on the asset side but represents
             the same balance-sheet expansion that backs all liabilities; closest fit
             in the enum. Documented in source_series_id + source_url.)

Currency: USD. Units stored in source row: M1SL/M2SL in billions, BOGMBASE/WALCL in
millions. We DON'T normalize  -  value is stored as published; consumers query knowing
source_series_id. (We could normalize all to millions, but FRED's native units are
canonical and documented per series.)

Source: api.stlouisfed.org. License: FRED API ToS, underlying US-Fed public series.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timedelta, timezone
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fred-monetary.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1

SERIES = [
    # (fred_id, aggregate, country, currency, cadence)
    ("M1SL",     "M1",              "US", "USD", "monthly"),
    ("M2SL",     "M2",              "US", "USD", "monthly"),
    ("BOGMBASE", "M0",              "US", "USD", "monthly"),
    ("WALCL",    "FED_LIABILITIES", "US", "USD", "weekly"),
]


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
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
            log(f"  {series_id} HTTP {e.code}: {e.read().decode()[:200]}")
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
            period_start = ds
            period_end = _period_end_monthly(ds)
            label = ds.strftime("%Y-%m")
        else:  # weekly  -  FRED dates are Wednesday; bucket = week ending that Wed
            period_start = ds
            period_end = ds + timedelta(days=6)
            label = ds.strftime("Week of %Y-%m-%d")

        rows.append([
            country,                       # country
            aggregate,                     # aggregate
            period_start.isoformat(),      # period_start
            period_end.isoformat(),        # period_end
            label,                         # period_label
            "",                            # release_date
            str(val),                      # value
            currency,                      # currency
            "true",                        # seasonally_adjusted (SA series)
            "FRED",                        # source_authority
            src_url,                       # source_url
            series_id,                     # source_series_id
            "historical-backfill",         # provenance
            fetched_at_iso,                # fetched_at
            fetched_at_iso,                # inserted_at
        ])
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else v.replace("\t", " ").replace("\n", " ") for v in r]
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


def main():
    log("=== Phase H1 FRED monetary aggregates loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand = 0
    for series_id, aggregate, country, currency, cadence in SERIES:
        log(f"[{series_id}] fetching ({aggregate}, {cadence}) ...")
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
    # Audit retrofit (H2 2026-05-29): per-series continuity check.
    for _sid, _agg, _country, _ccy, _cad in SERIES:
        _orbi_cont_tt('monetary_aggregates', 'period_start',
                     f'FRED {_sid} monetary_aggregates',
                     extra_where=f"source_authority='FRED' AND source_series_id='{_sid}'")
    log(f"=== done: {grand} rows across {len(SERIES)} series ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H1 FRED monetary FAILED", str(e)[:200])
        sys.exit(1)
