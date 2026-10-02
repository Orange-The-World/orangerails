#!/usr/bin/env python3
"""
Phase H Wave 1  -  Statistics Canada provincial wages loader → wages

Onboarded source (Wave 1 Batch C ToS deep-dive 2026-05-30, wiki doc
s9D9lhGtlO): Statistics Canada Open Licence.
  https://www.statcan.gc.ca/en/reference/licence

Citation (required verbatim, per StatCan Open Licence):
  "Adapted from Statistics Canada, <productId>, <date>. This does not
   constitute an endorsement by Statistics Canada of this product."

API: Web Data Service (WDS) bulk CSV path. Docs:
  https://www.statcan.gc.ca/en/developers/wds

For each cube we:
  1. POST getFullTableDownloadCSV/<pid>/en → returns a ZIP URL
  2. Download + extract CSV
  3. Parse rows, filter to provincial/territory wage measures only
  4. COPY into wages (ON CONFLICT DO NOTHING)
  5. Per-source continuity check
  6. Brittleness-safe Signal alert on FATAL.

V1 cubes (provincial earnings):
  14100064  LFS  -  Wages by industry, monthly. Provinces + Canada.
            We accept wage measures: avg hourly, avg weekly,
            median hourly, median weekly.
  14100203  SEPH  -  Average weekly earnings, all employees, by NAICS
            sector, monthly. Provinces + Canada.

ISO-style country codes: CA-AB, CA-BC, CA-MB, CA-NB, CA-NL, CA-NS,
CA-ON, CA-PE, CA-QC, CA-SK, CA-NT, CA-NU, CA-YT, and CA for rollups.
"""
import csv
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
import zipfile
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation

sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-statcan-provincial.log"
PSQL = "/opt/bb-support/scripts/psql-orange-world"
WDS = "https://www150.statcan.gc.ca/t1/wds/rest"
UA = "Mozilla/5.0 ORBI/1.0 (+https://wiki.abascal.ca/doc/orbi-mission)"

PROVINCE_CODE = {
    "Canada": "CA",
    "Newfoundland and Labrador": "CA-NL",
    "Prince Edward Island": "CA-PE",
    "Nova Scotia": "CA-NS",
    "New Brunswick": "CA-NB",
    "Quebec": "CA-QC",
    "Ontario": "CA-ON",
    "Manitoba": "CA-MB",
    "Saskatchewan": "CA-SK",
    "Alberta": "CA-AB",
    "British Columbia": "CA-BC",
    "Yukon": "CA-YT",
    "Northwest Territories": "CA-NT",
    "Nunavut": "CA-NU",
    "Atlantic provinces": "CA-AT",
    "Prairie provinces": "CA-PR",
}

# Cube → row-filter spec.
#   wage_col_label: value in the cube's wage-measure dimension column
#   wages_measure:  our internal measure code (CHECK-constrained)
#   uom_required:   accept rows where UOM is in this set (price-per-time, not headcount)
CUBES = [
    {
        "productId": 14100064,
        "label": "LFS-wages-by-industry",
        # The "Wages" column in this cube has values like:
        #   "Average hourly wage rate", "Average weekly wage rate",
        #   "Median hourly wage rate",  "Median weekly wage rate",
        #   "Total employees, all wages" (a count  -  skip).
        # Each maps to a wages.measure code.
        "wage_col": "Wages",
        "wage_map": {
            "Average hourly wage rate": "mean_hourly",
            "Average weekly wage rate": "mean_weekly",
            "Median hourly wage rate": "median_hourly",
            "Median weekly wage rate": "median_weekly",
        },
        "uom_required": {"Dollars", "Current dollars"},
        # Restrict to headline industry + total gender + total-age to keep V1
        # row count manageable. Industry-level slice can ship in V2.
        "filters": {
            "North American Industry Classification System (NAICS)": "Total employees, all industries",
            "Gender": "Total - Gender",
            "Age group": "15 years and over",
            "Type of work": "Both full- and part-time employees",
        },
        "currency": "CAD",
    },
    {
        "productId": 14100203,
        "label": "SEPH-weekly-earnings",
        # SEPH dollar values are average weekly earnings; the dimensions
        # 'Type of employees' and 'Overtime' qualify the slice. Map the
        # 'All employees / Including overtime' combination → mean_weekly.
        "wage_col": "Overtime",
        "wage_map": {
            "Including overtime": "mean_weekly",
        },
        "uom_required": {"Dollars", "Current dollars"},
        "filters": {
            "North American Industry Classification System (NAICS)": "Industrial aggregate excluding unclassified businesses [11-91N]",
            "Type of employees": "All employees",
        },
        "currency": "CAD",
    },
]

PROD_CACHE_DIR = "/var/cache/orbi-statcan"


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


def _http_json(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Content-Type": "application/json",
    })
    if body is not None:
        req.data = json.dumps(body).encode("utf-8")
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(req, timeout=120).read()
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            log(f"  HTTP {e.code} {url[:90]}")
            if e.code in (400, 404):
                return None
            time.sleep(8 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:200]}")
            time.sleep(8 * (attempt + 1))
    return None


def fetch_cube_zip(product_id):
    """Resolve full-table CSV URL and download the ZIP locally."""
    os.makedirs(PROD_CACHE_DIR, exist_ok=True)
    out_path = os.path.join(PROD_CACHE_DIR, f"{product_id}.zip")
    # Skip download if cached < 24h.
    if os.path.exists(out_path) and (time.time() - os.path.getmtime(out_path)) < 86400:
        log(f"  using cached zip: {out_path}")
        return out_path
    resp = _http_json(f"{WDS}/getFullTableDownloadCSV/{product_id}/en")
    if not resp or resp.get("status") != "SUCCESS":
        log(f"  getFullTableDownloadCSV failed for {product_id}: {resp}")
        return None
    csv_url = resp["object"]
    log(f"  downloading {csv_url}")
    req = urllib.request.Request(csv_url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=300) as r, open(out_path, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
    except Exception as e:
        log(f"  download failed: {e!r}")
        return None
    return out_path


def _parse_ref_date(s):
    """REF_DATE for monthly cubes is YYYY-MM. For annual cubes, YYYY."""
    s = s.strip().strip('"')
    if not s:
        return None
    if len(s) == 7 and s[4] == "-":
        y, m = int(s[:4]), int(s[5:7])
        ps = date(y, m, 1)
        if m == 12:
            nf = date(y + 1, 1, 1)
        else:
            nf = date(y, m + 1, 1)
        pe = date.fromordinal(nf.toordinal() - 1)
        return ps, pe, f"{y}-{m:02d}"
    if len(s) == 4 and s.isdigit():
        y = int(s)
        return date(y, 1, 1), date(y, 12, 31), str(y)
    return None


def iter_cube_rows(zip_path):
    """Yield dict-rows for the main CSV inside a StatCan ZIP."""
    with zipfile.ZipFile(zip_path) as z:
        main = [n for n in z.namelist() if n.endswith(".csv") and "MetaData" not in n][0]
        with z.open(main) as f:
            # StatCan CSVs are UTF-8 with BOM
            text = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
            reader = csv.DictReader(text)
            for row in reader:
                yield row


def build_rows(cube_spec, zip_path, fetched_at_iso):
    rows = []
    pid = cube_spec["productId"]
    wage_col = cube_spec["wage_col"]
    wage_map = cube_spec["wage_map"]
    uom_ok = cube_spec["uom_required"]
    filters = cube_spec["filters"]
    src_url = f"https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid={pid}"

    scanned = 0
    kept = 0
    for raw in iter_cube_rows(zip_path):
        scanned += 1
        geo = raw.get("GEO", "").strip()
        iso = PROVINCE_CODE.get(geo)
        if not iso:
            continue
        # Apply filter dimensions.
        skip = False
        for col, want in filters.items():
            if raw.get(col, "").strip() != want:
                skip = True
                break
        if skip:
            continue
        # Wage measure mapping.
        wage_label = raw.get(wage_col, "").strip()
        measure = wage_map.get(wage_label)
        if not measure:
            # Generalized SEPH-style: any 'weekly earnings' lowercase fuzzy
            if "weekly earnings" in wage_label.lower():
                measure = "mean_weekly"
            else:
                continue
        if raw.get("UOM", "").strip() not in uom_ok:
            continue
        ref = _parse_ref_date(raw.get("REF_DATE", ""))
        if not ref:
            continue
        ps, pe, label = ref
        val_s = raw.get("VALUE", "").strip()
        if not val_s:
            continue
        try:
            val = Decimal(val_s)
        except (InvalidOperation, Exception):
            continue
        if val <= 0:
            continue
        # region: include the wage-label + cube tag so the unique key
        # (country, region, measure, period_start, source_authority)
        # admits both 'avg' and 'median' AND multiple cubes.
        region = f"{cube_spec['label']}|{wage_label}"[:200]
        vector = raw.get("VECTOR", "").strip()
        rows.append([
            iso, region, measure, ps.isoformat(), pe.isoformat(), label,
            "", str(val), cube_spec["currency"], "", "STATCAN", src_url,
            f"{pid}:{vector}" if vector else str(pid),
            "historical-backfill", fetched_at_iso, fetched_at_iso,
        ])
        kept += 1
    log(f"  scanned {scanned:,} rows; kept {kept:,}")
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = [
            "\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ")
            for v in r
        ]
        lines.append("\t".join(fields))
    cols = (
        "country, region, measure, period_start, period_end, period_label, "
        "release_date, value, currency, base_year, source_authority, "
        "source_url, source_series_id, provenance, fetched_at, inserted_at"
    )
    # Chunk to keep psql memory bounded.
    total_inserted = 0
    CHUNK = 50000
    for i in range(0, len(lines), CHUNK):
        chunk = lines[i:i+CHUNK]
        data = "\n".join(chunk) + "\n"
        script = (
            "SET lock_timeout='60s';\n"
            f"CREATE TEMP TABLE _stg_w (LIKE wages INCLUDING DEFAULTS);\n"
            f"\\copy _stg_w ({cols}) FROM STDIN\n"
            + data + "\\.\n"
            f"WITH ins AS (INSERT INTO wages ({cols}) "
            f"SELECT {cols} FROM _stg_w ON CONFLICT (country, COALESCE(region,''), measure, period_start, source_authority) DO NOTHING RETURNING 1) "
            f"SELECT count(*) FROM ins;\n"
            "DROP TABLE _stg_w;\n"
        )
        r = subprocess.run(
            [PSQL, "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=600,
        )
        if r.returncode != 0:
            log(f"  COPY FAIL on chunk {i}: {r.stderr[:400]}")
            return -1
        _chunk_wrote = len(chunk)
        _out = (r.stdout or "").strip().splitlines()
        if _out:
            try:
                _chunk_wrote = int(_out[-1])
            except ValueError:
                log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
        total_inserted += _chunk_wrote
    return total_inserted


def main():
    log("=== Phase H Wave 1 StatCan provincial loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0

    for cube in CUBES:
        pid = cube["productId"]
        log(f"[cube {pid} {cube['label']}] fetching full-table CSV ...")
        zp = fetch_cube_zip(pid)
        if not zp:
            log(f"[cube {pid}] download failed  -  skipping")
            continue
        rows = build_rows(cube, zp, fetched_at)
        log(f"[cube {pid}] built {len(rows):,} candidate rows")
        n = copy_rows(rows)
        if n >= 0:
            grand_total += n
            log(f"[cube {pid}] wrote {n:,} rows")

    _orbi_cont_tt('wages', 'period_start',
                  'STATCAN provincial wages',
                  extra_where="source_authority='STATCAN'")
    log(f"=== done: {grand_total:,} candidate rows ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase H Wave 1 StatCan FAILED", str(e)[:200])
        sys.exit(1)
