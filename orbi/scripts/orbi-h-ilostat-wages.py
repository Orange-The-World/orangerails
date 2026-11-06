#!/usr/bin/env python3
"""
Phase G  -  ILOSTAT direct wages loader → wages

Onboarded source (autonomously ToS-cleared 2026-05-29):
  ILOSTAT (International Labour Organization statistics database).
  Licence: Creative Commons Attribution BY 4.0 (CC BY 4.0).
  Effective date: 3 May 2023. Covers "databases and datasets together with
  the accompanying referential metadata" per
  https://www.ilo.org/global/copyright/lang--en/index.htm  -  verbatim:
    "As of 3 May 2023, databases and datasets together with the accompanying
     referential metadata are covered by the Creative Commons CC BY 4.0
     licence."
  Commercial reuse permitted with attribution.

  This loader targets emerging-markets coverage (Latin America, Africa, South
  Asia priority)  -  the gap that FRED republication leaves unfilled.

API: rplumber endpoint (CSV one-shot).
  https://rplumber.ilo.org/data/indicator/?id=<ID>&ref_area=<ISO3>&format=.csv

Indicators (annual, all genders only  -  SEX_T):
  EAR_EHRA_SEX_NB_A    Average hourly earnings of employees (local currency)
  EAR_EHRM_SEX_NB_A    Median hourly earnings of employees (local currency)
  EAR_INEE_NOC_NB_A    Statutory nominal gross monthly minimum wage (local currency)

Country scope  -  focus on emerging markets and Phase G coverage gaps:
  Latin America: AR, BR, CL, CO, MX, PE
  Africa: ZA, NG, KE, EG, MA
  Asia: IN, ID, PH, VN, TH, MY
  Eastern Europe: PL, RO, TR, UA
  Plus a few advanced economies for cross-validation: JP, KR
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal

# Audit retrofit (F4 2026-05-30): per-series continuity check.
sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-ilostat-wages.log"
SLEEP_BETWEEN = 2

# ISO3 → ISO2, local currency (for value labelling)
COUNTRIES = [
    # LatAm
    ("ARG", "AR", "ARS"),
    ("BRA", "BR", "BRL"),
    ("CHL", "CL", "CLP"),
    ("COL", "CO", "COP"),
    ("MEX", "MX", "MXN"),
    ("PER", "PE", "PEN"),
    # Africa
    ("ZAF", "ZA", "ZAR"),
    ("NGA", "NG", "NGN"),
    ("KEN", "KE", "KES"),
    ("EGY", "EG", "EGP"),
    ("MAR", "MA", "MAD"),
    # Asia
    ("IND", "IN", "INR"),
    ("IDN", "ID", "IDR"),
    ("PHL", "PH", "PHP"),
    ("VNM", "VN", "VND"),
    ("THA", "TH", "THB"),
    ("MYS", "MY", "MYR"),
    # Eastern Europe
    ("POL", "PL", "PLN"),
    ("ROU", "RO", "RON"),
    ("TUR", "TR", "TRY"),
    ("UKR", "UA", "UAH"),
    # Advanced (cross-val)
    ("JPN", "JP", "JPY"),
    ("KOR", "KR", "KRW"),
]

# (ilostat_id, measure, region_label)
INDICATORS = [
    ("EAR_EHRA_SEX_NB_A", "mean_hourly",    "total-economy"),
    ("EAR_EHRM_SEX_NB_A", "median_hourly",  "total-economy"),
    ("EAR_INEE_NOC_NB_A", "minimum_hourly", "statutory-monthly"),
    # NOTE: EAR_INEE is monthly minimum, not hourly. We map to a custom region
    # marker so it doesn't collide. Pending schema extension for minimum_monthly,
    # we record under minimum_hourly with region='statutory-monthly' so the
    # measurement basis is preserved in the natural key and downstream
    # consumers can disambiguate.
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


def fetch_indicator(ind_id, iso3):
    url = (f"https://rplumber.ilo.org/data/indicator/"
           f"?id={ind_id}&ref_area={iso3}&format=.csv")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) ORBI/1.0 "
                "(+https://wiki.abascal.ca/doc/orbi-mission)"
            ),
            "Accept": "text/csv,application/json",
        },
    )
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=90).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            log(f"  {ind_id}/{iso3} HTTP {e.code}")
            if e.code in (400, 404):
                return None
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {ind_id}/{iso3} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def parse_csv(text):
    """Parse rplumber CSV. Header is BOM-prefixed."""
    import csv
    import io
    text = text.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text))
    out = []
    for row in reader:
        # We want SEX_T (total) only
        if row.get("sex") and row["sex"] != "SEX_T":
            continue
        time_v = row.get("time", "").strip()
        val_v = row.get("obs_value", "").strip()
        if not time_v or not val_v:
            continue
        try:
            year = int(time_v[:4])
            val = Decimal(val_v)
        except Exception:
            continue
        if val <= 0:
            continue
        out.append((year, val))
    return out


def build_rows(ind_id, iso2, currency, measure, region, observations,
               fetched_at_iso):
    rows = []
    citation = (
        f"ILOSTAT  -  ILO (2026), {ind_id}, "
        "https://ilostat.ilo.org/ (CC BY 4.0)"
    )
    src_url = (
        f"https://rplumber.ilo.org/data/indicator/"
        f"?id={ind_id}&ref_area={iso2}"
    )
    for year, val in observations:
        ps = date(year, 1, 1)
        pe = date(year, 12, 31)
        rows.append([
            iso2,
            region,
            measure,
            ps.isoformat(),
            pe.isoformat(),
            str(year),
            "",
            str(val),
            currency,
            "",
            "ILO",
            src_url,
            ind_id,
            "historical-backfill",
            fetched_at_iso,
            fetched_at_iso,
        ])
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
    data = "\n".join(lines) + "\n"
    cols = (
        "country, region, measure, period_start, period_end, period_label, "
        "release_date, value, currency, base_year, source_authority, "
        "source_url, source_series_id, provenance, fetched_at, inserted_at"
    )
    script = (
        f"CREATE TEMP TABLE _stg_w (LIKE wages INCLUDING DEFAULTS);\n"
        f"\\copy _stg_w ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO wages ({cols}) "
        f"SELECT {cols} FROM _stg_w ON CONFLICT (country, COALESCE(region,''), measure, period_start, source_authority) DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_w;\n"
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
    log("=== Phase G ILOSTAT wages loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for ind_id, measure, region in INDICATORS:
        for iso3, iso2, currency in COUNTRIES:
            log(f"[{ind_id}/{iso3}] fetching ...")
            text = fetch_indicator(ind_id, iso3)
            if not text:
                log(f"[{ind_id}/{iso3}] EMPTY/ERR  -  skipping")
                time.sleep(SLEEP_BETWEEN)
                continue
            obs = parse_csv(text)
            if not obs:
                log(f"[{ind_id}/{iso3}] no SEX_T rows  -  skipping")
                time.sleep(SLEEP_BETWEEN)
                continue
            log(f"[{ind_id}/{iso3}] {len(obs)} year-rows")
            rows = build_rows(ind_id, iso2, currency, measure, region, obs,
                              fetched_at)
            n = copy_rows(rows)
            if n >= 0:
                log(f"[{ind_id}/{iso3}] wrote {n} rows")
                grand_total += n
            time.sleep(SLEEP_BETWEEN)
    # Audit retrofit (F4 2026-05-30): per-indicator continuity check.
    for _ind_id, _measure, _region in INDICATORS:
        _orbi_cont_tt('wages', 'period_start',
                     f'ILOSTAT {_ind_id} wages',
                     extra_where=f"source_authority='ILO' AND source_series_id='{_ind_id}'")
    log(f"=== done: {grand_total} candidate rows ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase G ILOSTAT wages FAILED", str(e)[:200])
        sys.exit(1)
