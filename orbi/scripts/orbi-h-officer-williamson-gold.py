#!/usr/bin/env python3
"""
Phase H1  -  Officer & Williamson "Price of Gold, 1257-Present" full annual loader
            → historical_money_prices

Supersedes the hardcoded 28-row MEASURINGWORTH_GOLD_USD block in
orbi-h-lbma-metals.py (which has been removed).

Source: Lawrence H. Officer and Samuel H. Williamson, "The Price of Gold,
1257-Present," MeasuringWorth, 2024.
https://www.measuringworth.com/datasets/gold/

License: free academic / personal use with attribution per MeasuringWorth's
terms; ORBI redistributes the free public-truth side under CC-BY 4.0 per the
ORBI business model (per-row citation baked in).

Series loaded (avoiding USD/GBP unique-key collisions):
  British Official Price (1257-1945)   GBP/oz   region=GB
  US Official Price       (1786-1790)  USD/oz   region=US   -  only the pre-NY gap
  New York Market Price   (1791-2025)  USD/oz   region=US   -  canonical USD series

  Notes jsonb on each row records the exact MeasuringWorth series label so the
  semantic shape is preserved despite the unique-key dedup.

Cadence: ONE-SHOT service (no timer). MeasuringWorth updates annually at best;
re-run manually each January via:
  sudo systemctl start orbi-h-officer-williamson-gold.service
"""
import csv, io, json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-officer-williamson-gold.log"
SLEEP_BETWEEN = 3  # gentle on MeasuringWorth

EXPORT = "https://www.measuringworth.com/datasets/gold/export.php"

# (param_name, mw_series_label, asset, quote_in, region,
#  fetch_lo, fetch_hi, year_lo, year_hi)
# fetch_lo/fetch_hi must lie inside MeasuringWorth's supported window for the
# series (the export.php endpoint refuses out-of-range requests with an error
# page instead of CSV). year_lo/year_hi then clamp DB inserts to non-overlapping
# windows so the unique key (asset, quote_in, year_start, year_end,
# source_authority) doesn't collide across MeasuringWorth's overlapping series.
SERIES = [
    # British official price: supported 1257-1945
    ("British", "British Official Price (per fine ounce, end of year)",
     "XAU", "GBP_BRITISH_POUND", "GB", 1257, 1945, 1257, 1945),
    # US official price: supported 1786-2025; we only need 1786-1790 (pre-NY gap)
    ("us",      "US Official Price (per fine ounce, end of year)",
     "XAU", "USD", "US", 1786, 1790, 1786, 1790),
    # New York market price: supported 1791-2025
    ("newyork", "New York Market Price (per fine ounce)",
     "XAU", "USD", "US", 1791, 2025, 1791, 2099),
]

CITATION = (
    "Lawrence H. Officer and Samuel H. Williamson, 'The Price of Gold, "
    "1257-Present,' MeasuringWorth, 2024. "
    "https://www.measuringworth.com/datasets/gold/  -  used with attribution "
    "under MeasuringWorth's free academic/personal use grant. "
    "Free side licensed CC-BY 4.0 per ORBI business model."
)


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


def _signal_alert(subject, body=""):
    try:
        subprocess.run(["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body], timeout=15)
    except Exception:
        pass


def fetch_csv(param, fetch_lo, fetch_hi):
    # MeasuringWorth refuses years outside each series' supported range with an
    # error page (no CSV), so we pass fetch_lo/fetch_hi inside the supported
    # window for this specific series.
    url = (f"{EXPORT}?year_source={fetch_lo}&year_result={fetch_hi}&{param}=on")
    req = urllib.request.Request(url, headers={
        "User-Agent": "ORBI/1.0 research bot",
    })
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
            return raw
        except urllib.error.HTTPError as e:
            log(f"  {param} HTTP {e.code}: {e.read().decode()[:200]}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {param} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def parse_csv(raw):
    """MeasuringWorth CSV: a few quoted header/note lines, then 'Year','<col>' header,
    then data rows. We grab (year:int, value:Decimal) pairs and ignore notes."""
    out = []
    reader = csv.reader(io.StringIO(raw))
    seen_header = False
    for row in reader:
        if not row:
            continue
        if not seen_header:
            if row and row[0].strip().lower() == "year":
                seen_header = True
            continue
        # data row
        try:
            yr = int(row[0].strip())
        except (ValueError, IndexError):
            continue
        try:
            v = Decimal(row[1].strip())
        except (InvalidOperation, IndexError):
            continue
        if v <= 0:
            continue
        out.append((yr, v))
    return out


def build_rows(series_label, asset, quote_in, region, observations, year_lo, year_hi, fetched_at_iso):
    rows = []
    for yr, v in observations:
        if yr < year_lo or yr > year_hi:
            continue
        confidence = "scholarly" if yr < 1900 else "primary"
        period_label = f"{yr} annual"
        notes = json.dumps({
            "compiler": "Officer & Williamson",
            "publisher": "MeasuringWorth",
            "series": series_label,
        })
        rows.append([
            asset,                 # asset
            quote_in,              # quote_in
            str(yr),               # year_start
            str(yr),               # year_end
            period_label,          # period_label
            str(v),                # value
            "oz_troy",             # unit
            confidence,            # confidence
            "MEASURING_WORTH",     # source_authority
            CITATION,              # citation
            "Officer & Williamson",# compiler
            region,                # region
            notes,                 # notes
            fetched_at_iso,        # fetched_at
            fetched_at_iso,        # inserted_at
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
    cols = ("asset, quote_in, year_start, year_end, period_label, value, unit, "
            "confidence, source_authority, citation, compiler, region, notes, "
            "fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_ow (LIKE historical_money_prices INCLUDING DEFAULTS);\n"
        f"\\copy _stg_ow ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO historical_money_prices ({cols}) "
        f"SELECT {cols} FROM _stg_ow ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_ow;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=120,
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


def cleanup_legacy_rows():
    """Delete the 28 legacy asset='GOLD' rows from the old hardcoded block.
    The new loader supersedes them with asset='XAU' rows that match the
    canonical schema shape."""
    sql = ("DELETE FROM historical_money_prices "
           "WHERE asset='GOLD' AND source_authority='MEASURING_WORTH';")
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        log(f"  legacy cleanup FAIL: {r.stderr[:200]}")
    else:
        log("  legacy asset='GOLD' MEASURING_WORTH rows cleaned up")


def continuity_check():
    """Per-century row count over asset='XAU' MEASURING_WORTH rows.
    Centuries with 0 rows between MIN and MAX year → Signal alert."""
    sql = """
    SELECT (FLOOR(year_start/100.0)*100)::int AS century, COUNT(*) AS n
      FROM historical_money_prices
     WHERE asset='XAU' AND source_authority='MEASURING_WORTH'
     GROUP BY 1 ORDER BY 1;
    """
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-At", "-F", "|", "-c", sql],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        log(f"  continuity SQL FAIL: {r.stderr[:300]}")
        return
    by_c = {}
    for line in r.stdout.strip().splitlines():
        if not line:
            continue
        c, n = line.split("|")
        by_c[int(c)] = int(n)
    if not by_c:
        log("[continuity] no rows yet")
        return
    lo, hi = min(by_c), max(by_c)
    log(f"[continuity] centuries {lo}-{hi}; per century: " +
        ", ".join(f"{c}={by_c[c]}" for c in sorted(by_c)))
    zero = [c for c in range(lo, hi + 1, 100) if c not in by_c]
    if zero:
        _signal_alert("ORBI Officer-Williamson gold  -  century gaps",
                      f"Centuries with 0 rows: {zero}")


def main():
    log("=== Officer-Williamson gold loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand = 0
    for param, label, asset, quote_in, region, fetch_lo, fetch_hi, year_lo, year_hi in SERIES:
        log(f"[{param}] fetching ({label}) ...")
        raw = fetch_csv(param, fetch_lo, fetch_hi)
        if not raw:
            log(f"[{param}] EMPTY  -  skipping")
            continue
        obs = parse_csv(raw)
        log(f"[{param}] parsed {len(obs)} (year,value) pairs; clamping to [{year_lo},{year_hi}]")
        rows = build_rows(label, asset, quote_in, region, obs, year_lo, year_hi, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{param}] wrote {n} rows (ON CONFLICT DO NOTHING)")
            grand += n
        time.sleep(SLEEP_BETWEEN)
    log(f"=== load done: {grand} candidate rows across {len(SERIES)} series ===")
    cleanup_legacy_rows()
    try:
        continuity_check()
    except Exception as e:
        log(f"continuity check error (non-fatal): {e!r}")
    _sync_resolutions("orbi-backfill-historical-money-prices-resolutions.py")
    log("=== Officer-Williamson gold loader complete ===")


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
        r = subprocess.run([path], capture_output=True, text=True, timeout=1800)
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
        _signal_alert("ORBI Officer-Williamson gold FAILED", str(e)[:200])
        sys.exit(1)
