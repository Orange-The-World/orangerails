#!/usr/bin/env python3
"""
Phase H Wave 1  -  Bank for International Settlements loader (V1 starter slice)

Onboarded source (Wave 1 Batch B ToS deep-dive 2026-05-30, wiki doc
8g37Nb2Ive): BIS Statistics Service. Verbatim attribution clause:

  "If statistics will be used in a commercial publication or product,
   BIS must be cited as the source."

Citation (per row): "Bank for International Settlements, <flow>, used
with attribution."

API: BIS Statistics Service SDMX REST v1 (returns CSV).
  Base: https://stats.bis.org/api/v1/data/<flow>/<key>/all?format=csv

Schema routing (V1  -  pragmatic given ORBI CHECK constraints):
  WS_EER  (REER/NEER, monthly, 1964+) → historical_money_prices
            asset=<REF_AREA>_<EER_TYPE>_<EER_BASKET> e.g. US_R_B (broad real)
            quote_in='index', period_label='YYYY-MM'
  WS_LONG_CPI (annual, 1914+)          → inflation_rates
            index_kind='CPI_LONG'
  WS_CBPOL (policy rates, daily)        → historical_money_prices
            asset=<REF_AREA>_POLICY_RATE, quote_in='percent'
            Down-sampled to MONTH-END to keep V1 row count tractable.

V1 row-count target: ~150-300K (REER ~10K series × 12 months × 30 yrs is
3.6M alone, so we ship a starter slice of priority economies and
iterate up). Full surface is multi-week work  -  surfaced to founder.

Brittleness rule: Signal alerts try/except, never re-raise.
"""
import csv
import io
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation

sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-bis.log"
PSQL = "/opt/bb-support/scripts/psql-orange-world"
BIS = "https://stats.bis.org/api/v1/data"
UA = "Mozilla/5.0 ORBI/1.0 (+https://wiki.abascal.ca/doc/orbi-mission)"

CITATION = ("Bank for International Settlements, {flow}, used with "
            "attribution.")

# Priority economies for V1 ship (G20 + key emerging markets).
PRIORITY_REF_AREAS = [
    "US", "GB", "DE", "FR", "IT", "ES", "NL", "CH", "SE", "NO", "DK",
    "JP", "KR", "TW", "HK", "SG", "AU", "NZ",
    "CA", "MX", "BR", "AR", "CL", "CO", "PE",
    "IN", "ID", "TH", "PH", "MY", "VN",
    "ZA", "TR", "RU", "SA", "AE",
    "XM",  # Euro area
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


def _signal_alert(subject, body=""):
    try:
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
    except Exception:
        pass


def fetch_csv(flow, key):
    url = f"{BIS}/{flow}/{key}/all?format=csv"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "text/csv",
    })
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(req, timeout=180).read()
            return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            log(f"  {flow}/{key} HTTP {e.code}")
            if e.code in (400, 404):
                return None
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {flow}/{key} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


# ---------- WS_EER: REER/NEER → historical_money_prices ----------
def load_eer():
    # Key: FREQ.EER_TYPE.EER_BASKET.REF_AREA  - all dimensions wildcarded
    # except FREQ (M) and REF_AREA (priority list). We pull each REF_AREA
    # separately to stay under server-side row limits.
    flow = "WS_EER"
    src_url = f"https://stats.bis.org/statx/srs/table/H1"
    citation = CITATION.format(flow=flow)
    rows = []
    fetched_at_iso = datetime.now(timezone.utc).isoformat()
    for area in PRIORITY_REF_AREAS:
        key = f"M..{'.' if False else ''}.{area}"  # FREQ.EER_TYPE.EER_BASKET.REF_AREA
        key = f"M...{area}"
        log(f"  EER: pulling {area}")
        body = fetch_csv(flow, key)
        if not body:
            continue
        rdr = csv.DictReader(io.StringIO(body))
        for r in rdr:
            tp = (r.get("TIME_PERIOD") or "").strip()
            v = (r.get("OBS_VALUE") or "").strip()
            ref = (r.get("REF_AREA") or "").strip()
            etype = (r.get("EER_TYPE") or "").strip()    # N=nominal R=real
            basket = (r.get("EER_BASKET") or "").strip()  # B=broad N=narrow
            if not (tp and v and ref):
                continue
            if len(tp) != 7 or tp[4] != "-":
                continue
            try:
                y, m = int(tp[:4]), int(tp[5:7])
            except Exception:
                continue
            try:
                val = Decimal(v)
                if val.is_nan() or val <= 0:
                    continue
            except (InvalidOperation, Exception):
                continue
            asset = f"{ref}_{etype}EER_{basket}"
            rows.append([
                asset, "index", y, y, f"{y}-{m:02d}",
                str(val), "index", "primary", "BIS",
                citation, "BIS", ref, None,
                fetched_at_iso, fetched_at_iso,
            ])
    log(f"  EER total candidate rows: {len(rows):,}")
    return rows


# ---------- WS_LONG_CPI: annual long-history CPI → inflation_rates ----------
def load_long_cpi():
    flow = "WS_LONG_CPI"
    citation = CITATION.format(flow=flow)
    src_url = "https://stats.bis.org/statx/srs/table/F2"
    fetched_at_iso = datetime.now(timezone.utc).isoformat()
    log(f"  LONG_CPI: bulk download (annual, all countries)")
    body = fetch_csv(flow, "all")
    if not body:
        return []
    rdr = csv.DictReader(io.StringIO(body))
    rows = []
    for r in rdr:
        ref = (r.get("REF_AREA") or "").strip()
        tp = (r.get("TIME_PERIOD") or "").strip()
        v = (r.get("OBS_VALUE") or "").strip()
        if not (ref and tp and v):
            continue
        try:
            yr = int(tp[:4])
            val = Decimal(v)
            if val.is_nan() or val <= 0:
                continue
        except Exception:
            continue
        rows.append([
            ref, None, "CPI_LONG",
            f"{yr}-01-01", f"{yr}-12-31", str(yr),
            None, str(val), None, None, None, "source",
            0, None, "FINAL", "BIS", src_url,
            "WS_LONG_CPI", "historical-backfill",
            fetched_at_iso, fetched_at_iso,
        ])
    log(f"  LONG_CPI candidate rows: {len(rows):,}")
    return rows


# ---------- WS_CBPOL: central-bank policy rates → historical_money_prices ----------
def load_policy_rates():
    flow = "WS_CBPOL"
    citation = CITATION.format(flow=flow)
    fetched_at_iso = datetime.now(timezone.utc).isoformat()
    rows = []
    # Pull each country separately. Down-sample to month-end (last
    # available daily obs in each calendar month).
    for area in PRIORITY_REF_AREAS:
        key = f"D.{area}"  # FREQ.REF_AREA
        body = fetch_csv(flow, key)
        if not body:
            continue
        rdr = csv.DictReader(io.StringIO(body))
        # bucket by (year, month) → keep latest day's value
        bucket = {}
        for r in rdr:
            tp = (r.get("TIME_PERIOD") or "").strip()
            v = (r.get("OBS_VALUE") or "").strip()
            if not tp or not v:
                continue
            if len(tp) < 10:
                continue
            try:
                y, m, d = int(tp[:4]), int(tp[5:7]), int(tp[8:10])
                val = Decimal(v)
                if val.is_nan():
                    continue
            except Exception:
                continue
            key2 = (y, m)
            prev = bucket.get(key2)
            if prev is None or prev[0] < d:
                bucket[key2] = (d, val)
        log(f"  CBPOL {area}: {len(bucket)} month-end obs")
        asset = f"{area}_POLICY_RATE"
        for (y, m), (d, val) in sorted(bucket.items()):
            # historical_money_prices.value > 0  -  negative rates (SNB, ECB) skipped.
            if val <= 0:
                continue
            rows.append([
                asset, "percent", y, y, f"{y}-{m:02d}",
                str(val), "percent", "primary", "BIS",
                citation, "BIS", area, None,
                fetched_at_iso, fetched_at_iso,
            ])
    log(f"  CBPOL total candidate rows: {len(rows):,}")
    return rows


# ---------- COPY helpers ----------
def _to_tsv(rows):
    lines = []
    for r in rows:
        fields = [
            "\\N" if v is None or v == "" else str(v).replace("\t", " ").replace("\n", " ")
            for v in r
        ]
        lines.append("\t".join(fields))
    return "\n".join(lines) + "\n"


def copy_historical_money_prices(rows):
    if not rows:
        return 0
    cols = ("asset, quote_in, year_start, year_end, period_label, "
            "value, unit, confidence, source_authority, citation, "
            "compiler, region, notes, fetched_at, inserted_at")
    return _chunked_copy("historical_money_prices", cols, rows,
                         conflict_cols="(asset, quote_in, year_start, year_end, source_authority)")


def copy_inflation_rates(rows):
    if not rows:
        return 0
    cols = ("country, region, index_kind, period_start, period_end, "
            "period_label, release_date, value, base_year, yoy_pct, "
            "mom_pct, populated_by, revision_number, superseded_by_id, "
            "status, source_authority, source_url, source_series_id, "
            "provenance, fetched_at, inserted_at")
    return _chunked_copy("inflation_rates", cols, rows,
                         conflict_cols="(country, COALESCE(region,''), index_kind, period_start, revision_number, source_authority)")


def _chunked_copy(table, cols, rows, conflict_cols):
    total = 0
    CHUNK = 50000
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i+CHUNK]
        data = _to_tsv(chunk)
        script = (
            "SET lock_timeout='60s';\n"
            f"CREATE TEMP TABLE _stg (LIKE {table} INCLUDING DEFAULTS);\n"
            f"\\copy _stg ({cols}) FROM STDIN\n"
            + data + "\\.\n"
            f"INSERT INTO {table} ({cols}) SELECT {cols} FROM _stg "
            f"ON CONFLICT {conflict_cols} DO NOTHING;\n"
            "DROP TABLE _stg;\n"
        )
        r = subprocess.run(
            [PSQL, "-q", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=900,
        )
        if r.returncode != 0:
            log(f"  COPY FAIL on {table} chunk {i}: {r.stderr[:400]}")
            return -1
        total += len(chunk)
    return total


def main():
    log("=== Phase H Wave 1 BIS loader start ===")
    grand = 0

    log("--- WS_LONG_CPI ---")
    cpi_rows = load_long_cpi()
    n = copy_inflation_rates(cpi_rows)
    if n >= 0:
        grand += n
        log(f"  inflation_rates staged: {n:,}")
    _orbi_cont_tt('inflation_rates', 'period_start',
                  'BIS WS_LONG_CPI inflation_rates',
                  extra_where="source_authority='BIS' AND source_series_id='WS_LONG_CPI'")

    log("--- WS_CBPOL (policy rates, month-end) ---")
    cbpol_rows = load_policy_rates()
    n = copy_historical_money_prices(cbpol_rows)
    if n >= 0:
        grand += n
        log(f"  historical_money_prices (CBPOL) staged: {n:,}")

    log("--- WS_EER (REER/NEER, monthly, priority economies) ---")
    eer_rows = load_eer()
    n = copy_historical_money_prices(eer_rows)
    if n >= 0:
        grand += n
        log(f"  historical_money_prices (EER) staged: {n:,}")

    log(f"=== done: {grand:,} candidate rows ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase H Wave 1 BIS FAILED", str(e)[:200])
        sys.exit(1)
