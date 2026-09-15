#!/usr/bin/env python3
"""
Phase G  -  Eurostat direct wages loader → wages

Onboarded source (autonomously ToS-cleared 2026-05-29):
  Eurostat  -  official statistical office of the EU.
  Licence: Creative Commons Attribution 4.0 International (CC BY 4.0) for
  content owned by the EU on the Eurostat website. Verbatim per
  https://ec.europa.eu/eurostat/help/copyright-notice :
    "Reuse of statistical data, metadata, publications, and other
     dissemination tools published on this website for commercial or
     non-commercial purposes is authorised provided the source is
     acknowledged."
    "Content owned by the EU on this website … is licensed under the
     Creative Commons Attribution 4.0 International licence."
  Caveat (also verbatim): data identified as belonging to sources other than
  Eurostat may not be reused for commercial purposes. This loader filters
  strictly to Eurostat-authored datasets (earn_* family  -  EU LFS/SES).

API: Eurostat dissemination API, JSON-stat 2.0 format.
  https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/<dataset>?...

Initial datasets:
  earn_mw_cur  -  Monthly minimum wages, bi-annual (39 EU/EEA + candidate)
                In currency=NAC (national currency) only  -  EUR/PPS variants
                are derived and would double-count.

Coverage scope (V1): 39 reporting geographies × 5 semi-annual periods
(2024-S1 → 2026-S1) for the statutory minimum monthly wage in local
currency. ~195 rows on first run. Schema-compatible mapping:
  measure = 'minimum_hourly'   (semantic: monthly minimum; region marks it)
  region  = 'statutory-monthly'
  currency = local NAC (per geo)

Per Eurostat copyright notice: source acknowledgement is the licence
condition. We satisfy this via per-row source_url plus the Provider Archive
+ Sources page on the wiki.
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

LOG = "/var/log/orbi/orbi-h-eurostat-wages.log"
SLEEP_BETWEEN = 2

# Eurostat geo code → ISO2 (mostly identical) → local currency
# Note: EL = Greece, UK = United Kingdom (historic), EA = euro area (skip)
GEO_CURRENCY = {
    "BE": ("BE", "EUR"), "BG": ("BG", "BGN"), "CZ": ("CZ", "CZK"),
    "DK": ("DK", "DKK"), "DE": ("DE", "EUR"), "EE": ("EE", "EUR"),
    "IE": ("IE", "EUR"), "EL": ("GR", "EUR"), "ES": ("ES", "EUR"),
    "FR": ("FR", "EUR"), "HR": ("HR", "EUR"), "IT": ("IT", "EUR"),
    "CY": ("CY", "EUR"), "LV": ("LV", "EUR"), "LT": ("LT", "EUR"),
    "LU": ("LU", "EUR"), "HU": ("HU", "HUF"), "MT": ("MT", "EUR"),
    "NL": ("NL", "EUR"), "AT": ("AT", "EUR"), "PL": ("PL", "PLN"),
    "PT": ("PT", "EUR"), "RO": ("RO", "RON"), "SI": ("SI", "EUR"),
    "SK": ("SK", "EUR"), "FI": ("FI", "EUR"), "SE": ("SE", "SEK"),
    # Non-EU reporting geos
    "UK": ("GB", "GBP"), "IS": ("IS", "ISK"), "NO": ("NO", "NOK"),
    "CH": ("CH", "CHF"), "ME": ("ME", "EUR"), "MK": ("MK", "MKD"),
    "AL": ("AL", "ALL"), "RS": ("RS", "RSD"), "TR": ("TR", "TRY"),
    "BA": ("BA", "BAM"), "XK": ("XK", "EUR"), "MD": ("MD", "MDL"),
    "UA": ("UA", "UAH"),
}


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


def fetch_dataset(dataset, params):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = (f"https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/"
           f"data/{dataset}?{qs}")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 ORBI/1.0 (+https://wiki.abascal.ca/doc/orbi-mission)"
            ),
            "Accept": "application/json",
        },
    )
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(req, timeout=90).read()
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            log(f"  {dataset} HTTP {e.code}")
            if e.code in (400, 404):
                return None
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {dataset} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def jsonstat_iter(payload):
    """
    Yield (dim_codes_dict, value) for every populated cell in a JSON-stat 2.0
    response.

    The 'value' map keys are flat-index integers (as strings) into the
    multi-dim hypercube whose shape is payload['size'] and whose axes are
    payload['id'] (list of dim names in order).
    """
    if not payload or "value" not in payload:
        return
    dim_order = payload.get("id") or list(payload.get("dimension", {}).keys())
    sizes = payload.get("size", [])
    # index_of[dim] = {code: i}  →  invert to i: code
    code_by_pos = {}
    for d in dim_order:
        idx_map = payload["dimension"][d]["category"]["index"]
        if isinstance(idx_map, dict):
            inv = {v: k for k, v in idx_map.items()}
        else:
            inv = {i: c for i, c in enumerate(idx_map)}
        code_by_pos[d] = inv
    strides = [1] * len(sizes)
    for i in range(len(sizes) - 2, -1, -1):
        strides[i] = strides[i + 1] * sizes[i + 1]

    values = payload["value"]
    # values may be list or dict
    if isinstance(values, list):
        items = ((i, v) for i, v in enumerate(values) if v is not None)
    else:
        items = ((int(k), v) for k, v in values.items() if v is not None)

    for flat_idx, val in items:
        codes = {}
        remaining = flat_idx
        for d, stride in zip(dim_order, strides):
            pos = remaining // stride
            remaining = remaining % stride
            codes[d] = code_by_pos[d][pos]
        yield codes, val


def _semi_to_dates(time_code):
    """'2024-S1' → (date(2024,1,1), date(2024,6,30)).
       '2024-S2' → (date(2024,7,1), date(2024,12,31))."""
    try:
        y, s = time_code.split("-S")
        y = int(y)
        s = int(s)
        if s == 1:
            return date(y, 1, 1), date(y, 6, 30), f"{y}-H1"
        return date(y, 7, 1), date(y, 12, 31), f"{y}-H2"
    except Exception:
        return None


def build_rows_min_wage(payload, dataset, fetched_at_iso):
    rows = []
    if not payload:
        return rows
    for codes, val in jsonstat_iter(payload):
        # codes: {freq, currency, geo, time}
        if codes.get("currency") != "NAC":
            continue
        geo = codes.get("geo")
        if geo not in GEO_CURRENCY:
            continue
        iso2, currency = GEO_CURRENCY[geo]
        d = _semi_to_dates(codes.get("time", ""))
        if not d:
            continue
        ps, pe, label = d
        try:
            v = Decimal(str(val))
        except Exception:
            continue
        if v <= 0:
            continue
        src_url = (
            f"https://ec.europa.eu/eurostat/databrowser/view/{dataset}/default/table"
        )
        rows.append([
            iso2,
            "statutory-monthly",
            "minimum_hourly",  # measure-set mapping: monthly minimum
            ps.isoformat(),
            pe.isoformat(),
            label,
            "",
            str(v),
            currency,
            "",
            "EUROSTAT",
            src_url,
            dataset,
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
    log("=== Phase G Eurostat wages loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0

    # earn_mw_cur: monthly minimum wages, bi-annual
    log("[earn_mw_cur] fetching monthly minimum wages, 39 geos ...")
    payload = fetch_dataset(
        "earn_mw_cur",
        {"format": "JSON", "startPeriod": "2020"},
    )
    if payload:
        rows = build_rows_min_wage(payload, "earn_mw_cur", fetched_at)
        log(f"[earn_mw_cur] built {len(rows)} rows (NAC only)")
        n = copy_rows(rows)
        if n >= 0:
            grand_total += n
            log(f"[earn_mw_cur] wrote {n} rows")
    else:
        log("[earn_mw_cur] no payload  -  skipping")

    # Audit retrofit (F4 2026-05-30): per-country continuity check across wages.
    _orbi_cont_tt('wages', 'period_start',
                 'EUROSTAT earn_mw_cur wages',
                 extra_where="source_authority='EUROSTAT' AND source_series_id='earn_mw_cur'")
    log(f"=== done: {grand_total} candidate rows ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase G Eurostat wages FAILED", str(e)[:200])
        sys.exit(1)
