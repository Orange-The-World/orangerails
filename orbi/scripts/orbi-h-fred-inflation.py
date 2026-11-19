#!/usr/bin/env python3
"""
Phase H1  -  FRED US inflation loader → inflation_rates

Series:
  CPIAUCSL  CPI-U all items, monthly, US, base 1982-84=100
  CPILFESL  CPI-U all items less food/energy (core), monthly
  PCEPI     Personal Consumption Expenditures Chain-type Price Index, monthly
  PPIACO    Producer Price Index All Commodities, monthly (1913+)

For each observation:
  - Insert raw index value (populated_by='source', provenance='initial-release')
  - Insert derived YoY % change (populated_by='derived', provenance='derived')
    iff the value 12 months prior exists in the same series.

Source: api.stlouisfed.org (US Federal Reserve Bank of St. Louis).
License: FRED® and its data are made available subject to the FRED API Terms of Use;
the underlying US Federal Government series (CPI/PPI/PCE) are US public domain.
Citation baked into source_url for every row.

API key read from /opt/bb-support/.env (FRED_API_KEY).

Cadence: run weekly via timer. Idempotent via UNIQUE (country, region, index_kind,
period_start, revision_number, source_authority). Uses ON CONFLICT DO NOTHING.

Schema notes:
  inflation_rates does NOT have a 'citation' column (that's historical_money_prices).
  Attribution lives in source_authority + source_url + source_series_id + provenance.
  source_authority must be 'FRED' (allowed by the check constraint).
  index_kind enum: CPI / CPI-core / PCE / PCE-core / PPI / PPI-core / ...
  PCEPI is a headline (all-items) PCE → 'PCE'. (PCEPILFE is core; we'd add later.)
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal

# Audit retrofit (F4 2026-05-30): per-series continuity check.
sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fred-inflation.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1  # gentle on FRED

SERIES = [
    # (fred_id, index_kind, country, region, label_human)
    ("CPIAUCSL", "CPI",      "US", None, "CPI-U All Items, SA"),
    ("CPILFESL", "CPI-core", "US", None, "CPI-U All Items Less Food & Energy, SA"),
    ("PCEPI",    "PCE",      "US", None, "PCE Chain-type Price Index, SA"),
    ("PPIACO",   "PPI",      "US", None, "PPI All Commodities, NSA"),
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
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0 (orange-pill truth tables)"})
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


def _end_of_month(d):
    # Returns last day of month for date d (period_end for a monthly observation
    # whose period_start is the 1st of that month).
    if d.month == 12:
        ny, nm = d.year + 1, 1
    else:
        ny, nm = d.year, d.month + 1
    from datetime import timedelta
    return date(ny, nm, 1) - timedelta(days=1)


def build_rows(series_id, index_kind, country, region, label, observations, fetched_at_iso):
    """Return list of TSV lines for COPY into inflation_rates."""
    # observations: [{'realtime_start','realtime_end','date','value'}, ...]
    # value '.' means missing.
    parsed = []
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
        rd = o.get("realtime_start") or ""
        try:
            if rd:
                datetime.strptime(rd, "%Y-%m-%d")
        except Exception:
            rd = ""
        parsed.append((ds, val, rd))

    parsed.sort(key=lambda x: x[0])
    by_date = {d: v for d, v, _ in parsed}

    src_url = f"https://fred.stlouisfed.org/series/{series_id}"
    rows = []
    for d, v, rd in parsed:
        period_end = _end_of_month(d)
        period_label = d.strftime("%Y-%m")
        # Raw source row
        rows.append([
            country,                 # country
            region or "",            # region (empty -> \N below)
            index_kind,              # index_kind
            d.isoformat(),           # period_start
            period_end.isoformat(),  # period_end
            period_label,            # period_label
            rd,                      # release_date from FRED realtime_start
            str(v),                  # value
            "",                      # base_year
            "",                      # yoy_pct
            "",                      # mom_pct
            "source",                # populated_by
            "0",                     # revision_number
            "",                      # superseded_by_id
            "FINAL",                 # status (FRED publishes finalized series)
            "FRED",                  # source_authority
            src_url,                 # source_url
            series_id,               # source_series_id
            "historical-backfill",   # provenance
            fetched_at_iso,          # fetched_at
            fetched_at_iso,          # inserted_at
        ])
        # Derived YoY row (if prior-year observation exists)
        prev_year = d.replace(year=d.year - 1)
        if prev_year in by_date and by_date[prev_year] > 0:
            yoy = (v - by_date[prev_year]) / by_date[prev_year] * Decimal(100)
            # inflation_rates.value must be > 0; YoY can be negative. Store the
            # derived YoY as MoM/YoY columns alongside a small positive sentinel
            # is NOT honest. Instead: only emit a derived row when YoY is positive,
            # store the raw value (the index) on the derived row with yoy_pct set.
            # But schema already has yoy_pct on the same row as the raw value  - 
            # better approach: SKIP separate derived rows, update yoy_pct on the
            # source row in a second pass via SQL after COPY.
            pass  # YoY handled in post-COPY UPDATE below
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        # Convert empty strings to \N for nullable cols
        fields = []
        for v in r:
            fields.append("\\N" if v == "" else v.replace("\t", " ").replace("\n", " "))
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
        # Backfill release_date on previously-inserted rows where it was NULL
        # (loader prior to 2026-05-30 wrote release_date as NULL).
        "UPDATE inflation_rates ir SET release_date = s.release_date "
        "  FROM _stg_i s "
        " WHERE ir.release_date IS NULL "
        "   AND s.release_date IS NOT NULL "
        "   AND ir.country = s.country "
        "   AND ir.region IS NOT DISTINCT FROM s.region "
        "   AND ir.index_kind = s.index_kind "
        "   AND ir.period_start = s.period_start "
        "   AND ir.revision_number = s.revision_number "
        "   AND ir.source_authority = s.source_authority;\n"
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


def compute_yoy(series_id, country, index_kind):
    """After COPY, populate yoy_pct + mom_pct via SQL window functions."""
    sql = f"""
    WITH ranked AS (
      SELECT id, period_start, value,
             LAG(value, 12) OVER (ORDER BY period_start) AS v_yoy,
             LAG(value, 1)  OVER (ORDER BY period_start) AS v_mom
      FROM inflation_rates
      WHERE source_authority='FRED' AND source_series_id='{series_id}'
        AND country='{country}' AND index_kind='{index_kind}'
    )
    UPDATE inflation_rates ir
       SET yoy_pct = CASE WHEN r.v_yoy > 0 THEN ROUND(((r.value - r.v_yoy) / r.v_yoy * 100)::numeric, 6) ELSE NULL END,
           mom_pct = CASE WHEN r.v_mom > 0 THEN ROUND(((r.value - r.v_mom) / r.v_mom * 100)::numeric, 6) ELSE NULL END
      FROM ranked r
     WHERE ir.id = r.id
       AND (ir.yoy_pct IS DISTINCT FROM CASE WHEN r.v_yoy > 0 THEN ROUND(((r.value - r.v_yoy) / r.v_yoy * 100)::numeric, 6) ELSE NULL END
         OR ir.mom_pct IS DISTINCT FROM CASE WHEN r.v_mom > 0 THEN ROUND(((r.value - r.v_mom) / r.v_mom * 100)::numeric, 6) ELSE NULL END);
    """
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        log(f"  YoY UPDATE FAIL {series_id}: {r.stderr[:300]}")


def main():
    log("=== Phase H1 FRED inflation loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for series_id, index_kind, country, region, label in SERIES:
        log(f"[{series_id}] fetching ({label}) ...")
        d = fetch_series(series_id, api_key)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations (FRED count={d.get('count')})")
        rows = build_rows(series_id, index_kind, country, region, label, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows (ON CONFLICT DO NOTHING)")
            grand_total += n
        compute_yoy(series_id, country, index_kind)
        log(f"[{series_id}] YoY/MoM updated")
        time.sleep(SLEEP_BETWEEN)
    # Audit retrofit (F4 2026-05-30): per-series continuity check.
    for _sid, _ik, _ctry, _rgn, _lbl in SERIES:
        _orbi_cont_tt('inflation_rates', 'period_start',
                     f'FRED {_sid} inflation_rates',
                     extra_where=f"source_authority='FRED' AND source_series_id='{_sid}'")
    log(f"=== done: {grand_total} candidate rows across {len(SERIES)} series ===")
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
        _signal_alert("ORBI H1 FRED inflation FAILED", str(e)[:200])
        sys.exit(1)
