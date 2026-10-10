#!/usr/bin/env python3
"""
Phase H1  -  MeasuringWorth companion-series loader.

Extends the Officer-Williamson gold loader pattern to the other MeasuringWorth
free-tier datasets:

  /datasets/uscpi/    US CPI 1774-present                  → inflation_rates (CPI_LONG)
  /datasets/ukearncpi/   UK RPI + nominal wages + real wages 1209-present
                                                          → inflation_rates (RPI)
                                                          → wages (nominal_annual, real_annual)

(Silver and oats are NOT present on MeasuringWorth as standalone exports;
verified via curl on 2026-05-29  -  only /gold/ exists for metals; agricultural
prices are in Allen-Unger, not MeasuringWorth.)

One-shot service. Re-run manually in January each year.
"""
import csv, io, json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-measuringworth-companion.log"
SLEEP_BETWEEN = 3

USCPI_URL = "https://www.measuringworth.com/datasets/uscpi/export.php?year_source=1774&year_result=2025"
UKEARNCPI_URL = (
    "https://www.measuringworth.com/datasets/ukearncpi/export.php"
    "?year_source=1209&year_result=2025&use%5B%5D=CPI&use%5B%5D=WAGE&use%5B%5D=REALEARN"
)

CITATION_USCPI = (
    "Officer & Williamson, 'The Annual Consumer Price Index for the United "
    "States, 1774-Present,' MeasuringWorth, 2026. "
    "https://www.measuringworth.com/datasets/uscpi/  -  used with attribution "
    "under MeasuringWorth's free academic/personal use grant."
)
CITATION_UKEARN = (
    "Greg Clark, 'What Were the UK Earnings and Prices Then?' MeasuringWorth, "
    "2026. https://www.measuringworth.com/datasets/ukearncpi/  -  used with "
    "attribution under MeasuringWorth's free academic/personal use grant."
)


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


def _signal_alert(subject, body=""):
    try:
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
    except Exception:
        pass


def fetch_csv(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "ORBI/1.0 research bot",
    })
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            log(f"  HTTP {e.code}: {e.read().decode()[:200]}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def parse_csv(raw):
    """Returns (header_cols, rows_as_dicts) where header_cols[0] == 'Year'."""
    reader = csv.reader(io.StringIO(raw))
    header = None
    rows = []
    for r in reader:
        if not r:
            continue
        if header is None:
            if r and r[0].strip().lower() == "year":
                header = [c.strip() for c in r]
            continue
        try:
            yr = int(r[0].strip())
        except (ValueError, IndexError):
            continue
        d = {header[0]: yr}
        for i in range(1, len(header)):
            try:
                cell = r[i].strip().replace(",", "")
            except IndexError:
                cell = ""
            if cell in ("", "NA", "N/A", "-"):
                d[header[i]] = None
                continue
            try:
                d[header[i]] = Decimal(cell)
            except InvalidOperation:
                d[header[i]] = None
        rows.append(d)
    return header, rows


# ------------------ inflation_rates COPY ------------------

def insert_inflation(rows):
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
        input=script, capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        log(f"  inflation COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def insert_wages(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, region, measure, period_start, period_end, period_label, "
            "release_date, value, currency, base_year, source_authority, "
            "source_url, source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_w (LIKE wages INCLUDING DEFAULTS);\n"
        f"\\copy _stg_w ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO wages ({cols}) "
        f"SELECT {cols} FROM _stg_w ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_w;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        log(f"  wages COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def load_uscpi(fetched_at):
    log("[uscpi] fetching ...")
    raw = fetch_csv(USCPI_URL)
    if not raw:
        log("[uscpi] EMPTY"); return 0
    header, parsed = parse_csv(raw)
    log(f"[uscpi] parsed {len(parsed)} rows; cols={header}")
    rows = []
    for d in parsed:
        yr = d["Year"]
        v = next((d[c] for c in header if c.lower().startswith("u.s.") or "consumer price index" in c.lower()), None)
        if v is None or v <= 0:
            continue
        period_label = f"{yr} annual"
        rows.append([
            "US", "", "CPI_LONG",
            f"{yr}-01-01", f"{yr}-12-31", period_label,
            "", str(v), "1983",  # base 1982-84=100; pick midpoint year
            "", "",
            "source", "0", "", "FINAL", "MEASURING_WORTH",
            "https://www.measuringworth.com/datasets/uscpi/",
            "MW_USCPI_1774", "historical-backfill",
            fetched_at, fetched_at,
        ])
    n = insert_inflation(rows)
    log(f"[uscpi] wrote {n} rows")
    return n if n > 0 else 0


def load_ukearncpi(fetched_at):
    log("[ukearncpi] fetching ...")
    raw = fetch_csv(UKEARNCPI_URL)
    if not raw:
        log("[ukearncpi] EMPTY"); return 0
    header, parsed = parse_csv(raw)
    log(f"[ukearncpi] parsed {len(parsed)} rows; cols={header}")
    # Identify columns
    rpi_col = next((c for c in header if "retail price" in c.lower()), None)
    nominal_col = next((c for c in header if "nominal earnings" in c.lower()), None)
    real_col = next((c for c in header if "real earnings" in c.lower()), None)
    log(f"[ukearncpi] rpi={rpi_col} | nominal={nominal_col} | real={real_col}")

    inflation_rows = []
    wage_rows = []
    for d in parsed:
        yr = d["Year"]
        if rpi_col and d.get(rpi_col) and d[rpi_col] > 0:
            inflation_rows.append([
                "GB", "", "RPI",
                f"{yr}-01-01", f"{yr}-12-31", f"{yr} annual",
                "", str(d[rpi_col]), "2010",
                "", "",
                "source", "0", "", "FINAL", "MEASURING_WORTH",
                "https://www.measuringworth.com/datasets/ukearncpi/",
                "MW_UK_RPI_1209", "historical-backfill",
                fetched_at, fetched_at,
            ])
        if nominal_col and d.get(nominal_col) and d[nominal_col] > 0:
            wage_rows.append([
                "GB", "", "nominal_annual",
                f"{yr}-01-01", f"{yr}-12-31", f"{yr} annual",
                "", str(d[nominal_col]), "GBP", "",
                "MEASURING_WORTH",
                "https://www.measuringworth.com/datasets/ukearncpi/",
                "MW_UK_NOMINAL_EARN_1209", "historical-backfill",
                fetched_at, fetched_at,
            ])
        if real_col and d.get(real_col) and d[real_col] > 0:
            wage_rows.append([
                "GB", "", "real_annual",
                f"{yr}-01-01", f"{yr}-12-31", f"{yr} annual",
                "", str(d[real_col]), "GBP", "2010",
                "MEASURING_WORTH",
                "https://www.measuringworth.com/datasets/ukearncpi/",
                "MW_UK_REAL_EARN_1209", "historical-backfill",
                fetched_at, fetched_at,
            ])
    n_inf = insert_inflation(inflation_rows)
    n_w = insert_wages(wage_rows)
    log(f"[ukearncpi] wrote {n_inf} inflation rows + {n_w} wage rows")
    return (n_inf if n_inf > 0 else 0) + (n_w if n_w > 0 else 0)


def continuity_check_end_of_run():
    try:
        sql = (
            "SELECT 'inflation_rates' tbl, source_series_id, count(*), "
            "  min(period_start), max(period_start) "
            "FROM inflation_rates "
            "WHERE source_authority='MEASURING_WORTH' "
            "GROUP BY 2 "
            "UNION ALL "
            "SELECT 'wages', source_series_id, count(*), "
            "  min(period_start), max(period_start) "
            "FROM wages "
            "WHERE source_authority='MEASURING_WORTH' "
            "GROUP BY 2 "
            "ORDER BY 1,2;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (MeasuringWorth companion):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== Phase H1 MeasuringWorth companion loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    total = 0
    total += load_uscpi(fetched_at)
    time.sleep(SLEEP_BETWEEN)
    total += load_ukearncpi(fetched_at)
    log(f"=== done: {total} total rows ===")
    continuity_check_end_of_run()
    _sync_resolutions("orbi-backfill-inflation-resolutions.py")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI MW companion FAILED", str(e)[:200])
        sys.exit(1)


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

