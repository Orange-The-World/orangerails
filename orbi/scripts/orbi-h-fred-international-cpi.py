#!/usr/bin/env python3
"""
Phase H1  -  FRED INTERNATIONAL CPI loader → inflation_rates

Series (level-form, OECD/national via FRED):
  CP0000EZ19M086NEST  EU HICP (Eurozone 19, 2015=100)  -  monthly      → HICP
  CPALCY01JPM661N     Japan CPI (2015=100)              -  monthly      → CPI
                      [series ends 2022-04; older obs only]
  CANCPIALLMINMEI     Canada CPI (2015=100)             -  monthly      → CPI
  AUSCPIALLQINMEI     Australia CPI (2015=100)          -  quarterly    → CPI
  CHECPIALLMINMEI     Switzerland CPI (2015=100)        -  monthly      → CPI

Note on series selection: the original spec listed *657N growth-rate variants for
JP/CA/AU which are signed % changes (can go negative, breaks `value > 0` constraint).
We use the level-form OECD/national series with the same coverage so YoY is
recomputed honestly via window functions post-COPY.

source_authority='FRED' (data lineage via Federal Reserve Bank of St. Louis).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/opt/bb-support/scripts")

LOG = "/var/log/orbi/orbi-h-fred-international-cpi.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1

SERIES = [
    # (fred_id, index_kind, country, region, cadence, label)
    ("CP0000EZ19M086NEST", "HICP", "EU", None, "monthly",   "HICP Eurozone 19, 2015=100"),
    ("CPALCY01JPM661N",    "CPI",  "JP", None, "monthly",   "Japan CPI, 2015=100 (OECD)"),
    ("CANCPIALLMINMEI",    "CPI",  "CA", None, "monthly",   "Canada CPI, 2015=100"),
    ("AUSCPIALLQINMEI",    "CPI",  "AU", None, "quarterly", "Australia CPI, 2015=100"),
    ("CHECPIALLMINMEI",    "CPI",  "CH", None, "monthly",   "Switzerland CPI, 2015=100"),
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
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
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


def _period_end(d, cadence):
    if cadence == "quarterly":
        m = d.month + 3
        y = d.year + (m - 1) // 12
        m = ((m - 1) % 12) + 1
        return date(y, m, 1) - timedelta(days=1)
    # monthly
    if d.month == 12:
        ny, nm = d.year + 1, 1
    else:
        ny, nm = d.year, d.month + 1
    return date(ny, nm, 1) - timedelta(days=1)


def _period_label(d, cadence):
    if cadence == "quarterly":
        return f"{d.year}-Q{((d.month - 1) // 3) + 1}"
    return d.strftime("%Y-%m")


def build_rows(series_id, index_kind, country, region, cadence, observations, fetched_at_iso):
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
        pe = _period_end(ds, cadence)
        rows.append([
            country, region or "", index_kind,
            ds.isoformat(), pe.isoformat(), _period_label(ds, cadence),
            "", str(val), "", "", "",
            "source", "0", "", "FINAL", "FRED",
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
    cols = ("country, region, index_kind, period_start, period_end, period_label, "
            "release_date, value, base_year, yoy_pct, mom_pct, populated_by, "
            "revision_number, superseded_by_id, status, source_authority, source_url, "
            "source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_i (LIKE inflation_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_i ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO inflation_rates ({cols}) "
        f"SELECT {cols} FROM _stg_i ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_i;\n"
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


def compute_yoy(series_id, country, index_kind, cadence):
    lag_n = 4 if cadence == "quarterly" else 12
    mom_n = 1
    sql = f"""
    WITH ranked AS (
      SELECT id, period_start, value,
             LAG(value, {lag_n}) OVER (ORDER BY period_start) AS v_yoy,
             LAG(value, {mom_n}) OVER (ORDER BY period_start) AS v_mom
      FROM inflation_rates
      WHERE source_authority='FRED' AND source_series_id='{series_id}'
        AND country='{country}' AND index_kind='{index_kind}'
    )
    UPDATE inflation_rates ir
       SET yoy_pct = CASE WHEN r.v_yoy > 0 THEN ROUND(((r.value - r.v_yoy) / r.v_yoy * 100)::numeric, 6) ELSE NULL END,
           mom_pct = CASE WHEN r.v_mom > 0 THEN ROUND(((r.value - r.v_mom) / r.v_mom * 100)::numeric, 6) ELSE NULL END
      FROM ranked r
     WHERE ir.id = r.id;
    """
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        log(f"  YoY UPDATE FAIL {series_id}: {r.stderr[:300]}")


def continuity_check_end_of_run():
    """Per-country row-count + min/max date audit; alert on absurd gaps."""
    try:
        sql = (
            "SELECT country, index_kind, source_series_id, count(*) AS n, "
            "  min(period_start), max(period_start) "
            "FROM inflation_rates "
            "WHERE source_authority='FRED' "
            "  AND source_series_id IN ('CP0000EZ19M086NEST','CPALCY01JPM661N',"
            "    'CANCPIALLMINMEI','AUSCPIALLQINMEI','CHECPIALLMINMEI') "
            "GROUP BY 1,2,3 ORDER BY 1;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (international CPI):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
        # Alert if any series has 0 rows
        if "0 rows" in (r.stdout or "") or not r.stdout:
            _signal_alert("ORBI int'l CPI continuity: empty result", r.stdout[:400])
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== Phase H1 FRED international CPI loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for series_id, index_kind, country, region, cadence, label in SERIES:
        log(f"[{series_id}] fetching ({label}) ...")
        d = fetch_series(series_id, api_key)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations")
        rows = build_rows(series_id, index_kind, country, region, cadence, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows (ON CONFLICT DO NOTHING)")
            grand_total += n
        compute_yoy(series_id, country, index_kind, cadence)
        log(f"[{series_id}] YoY/MoM updated")
        time.sleep(SLEEP_BETWEEN)
    log(f"=== done: {grand_total} candidate rows across {len(SERIES)} series ===")
    continuity_check_end_of_run()
    _sync_resolutions("orbi-backfill-inflation-resolutions.py")

def _sync_resolutions(script_name):
    """Audit retrofit (2026-05-29): after every loader run, ensure every
    truth-table row has a matching *_resolutions audit row. Idempotent
    set-based anti-join INSERT lives in the backfill script. Call is non-fatal
    because audit gaps must alert but never block ingest."""
    path = f"/opt/bb-support/scripts/{script_name}"
    if not os.path.exists(path):
        log(f"  resolution-sync: {path} missing, skipping")
        return
    try:
        r = subprocess.run([path], capture_output=True, text=True, timeout=900)
        log(f"  resolution-sync ({script_name}) rc={r.returncode}")
        if r.returncode != 0:
            log(f"  resolution-sync stderr: {r.stderr[:300]}")
            _signal_alert(f"ORBI resolution-sync FAILED ({script_name})",
                          r.stderr[:200])
    except Exception as e:
        log(f"  resolution-sync exception: {e!r}")
        _signal_alert(f"ORBI resolution-sync exception ({script_name})",
                      str(e)[:200])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H1 FRED int'l CPI FAILED", str(e)[:200])
        sys.exit(1)

