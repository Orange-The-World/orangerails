#!/usr/bin/env python3
"""
Phase G  -  OECD direct wages loader → wages

Onboarded source (autonomously ToS-cleared 2026-05-29):
  OECD (Organisation for Economic Co-operation and Development).
  Licence: Creative Commons Attribution BY 4.0 (CC BY 4.0).
  Effective date: 1 July 2024. Default policy "Open Access by Default".
  Verbatim per https://www.oecd.org/en/about/oecd-open-by-default-policy.html
  and OECD Terms & Conditions:
    "Most OECD written content published as of 1 July 2024 is licensed under
     a Creative Commons Attribution BY 4.0 licence (CC BY 4.0)."
    "You can extract from, download, copy, adapt, print, distribute, share
     and embed Data for any purpose, even for commercial use, provided you
     give appropriate credit to the OECD by using the citation associated
     with the relevant Data."
  Commercial reuse permitted with attribution.

Why direct vs FRED republication:
  - FRED republishes only LCEAMN01* manufacturing hourly series for a
    handful of OECD countries.
  - OECD direct gives us the Average Annual Wage series (AV_AN_WAGE)
    covering ALL 43 OECD countries on a comparable basis, with both
    nominal-local and USD_PPP variants for cross-country comparison.

API: SDMX-JSON 2.0 at sdmx.oecd.org.
  Dataflow: OECD.ELS.SAE,DSD_EARNINGS@AV_AN_WAGE,1.0

V1 scope: PRICE_BASE='V' (current prices), UNIT_MEASURE in {USD_PPP, local-EUR-or-USD},
mean across all employees. Annual periodicity.
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
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-oecd-direct.log"

# OECD ISO3 → ISO2 mapping for the AV_AN_WAGE dataflow (all 43 reporting
# countries observed in API response 2026-05-29).
ISO3_TO_ISO2 = {
    "AUS": "AU", "AUT": "AT", "BEL": "BE", "CAN": "CA", "CHL": "CL",
    "COL": "CO", "CRI": "CR", "CZE": "CZ", "DNK": "DK", "EST": "EE",
    "FIN": "FI", "FRA": "FR", "DEU": "DE", "GRC": "GR", "HUN": "HU",
    "ISL": "IS", "IRL": "IE", "ISR": "IL", "ITA": "IT", "JPN": "JP",
    "KOR": "KR", "LVA": "LV", "LTU": "LT", "LUX": "LU", "MEX": "MX",
    "NLD": "NL", "NZL": "NZ", "NOR": "NO", "POL": "PL", "PRT": "PT",
    "SVK": "SK", "SVN": "SI", "ESP": "ES", "SWE": "SE", "CHE": "CH",
    "TUR": "TR", "GBR": "GB", "USA": "US",
    # Accession / partner reporters that may appear
    "BGR": "BG", "HRV": "HR", "ROU": "RO",
    "BRA": "BR", "RUS": "RU",
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


def fetch():
    url = (
        "https://sdmx.oecd.org/public/rest/data/"
        "OECD.ELS.SAE,DSD_EARNINGS@AV_AN_WAGE,1.0/"
        "all?startPeriod=1990"
    )
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 ORBI/1.0",
            "Accept": "application/vnd.sdmx.data+json",
        },
    )
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(req, timeout=120).read()
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            log(f"  HTTP {e.code}")
            if e.code in (400, 404):
                return None
            time.sleep(15 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:200]}")
            time.sleep(15 * (attempt + 1))
    return None


def build_rows(payload, fetched_at_iso):
    """Walk SDMX-JSON 2.0 dataSets[0].series + structures[0].dimensions.

    series_key like '1:0:0:0:0:0:0' indexes into series-dim values; obs key
    indexes into observation-dim values (just TIME_PERIOD here).
    """
    rows = []
    if not payload:
        return rows
    data = payload.get("data", {})
    structs = data.get("structures") or []
    if not structs:
        return rows
    s = structs[0]
    dim_s = s.get("dimensions", {}).get("series", [])
    dim_o = s.get("dimensions", {}).get("observation", [])

    # Build code-lookups
    def codes_of(dim_list):
        return [
            (d.get("id"), [v.get("id") for v in d.get("values", [])])
            for d in dim_list
        ]

    series_dims = codes_of(dim_s)
    obs_dims = codes_of(dim_o)
    sd_ids = [n for n, _ in series_dims]

    ds_list = data.get("dataSets", [])
    if not ds_list:
        return rows
    series = ds_list[0].get("series", {})

    for series_key, sval in series.items():
        idxs = [int(x) for x in series_key.split(":")]
        codes = {sd_ids[i]: series_dims[i][1][idxs[i]] for i in range(len(idxs))}
        ref_area = codes.get("REF_AREA")
        unit_measure = codes.get("UNIT_MEASURE")
        price_base = codes.get("PRICE_BASE")
        pay_period = codes.get("PAY_PERIOD")
        # Filter: nominal current-prices (V), USD_PPP for comparable, plus
        # local-currency representations (EUR, USD, GBP, JPY, ...). Skip
        # constant-price 'Q' to avoid index confusion in level-form table.
        if price_base != "V":
            continue
        if pay_period != "A":
            continue
        if ref_area not in ISO3_TO_ISO2:
            continue
        iso2 = ISO3_TO_ISO2[ref_area]

        # Map UNIT_MEASURE → currency string for our table.
        if unit_measure == "USD_PPP":
            currency = "USD"
            region = "ppp-converted"
        else:
            # Unit codes match ISO 4217 (EUR, AUD, CAD, CLP, ...).
            currency = unit_measure
            region = "nominal-local"

        obs = sval.get("observations", {})
        for ok, ov in obs.items():
            try:
                year_idx = int(ok)
            except Exception:
                continue
            try:
                year = int(obs_dims[0][1][year_idx])
            except Exception:
                continue
            try:
                val = Decimal(str(ov[0]))
            except Exception:
                continue
            if val <= 0:
                continue
            ps = date(year, 1, 1)
            pe = date(year, 12, 31)
            src_url = (
                "https://sdmx.oecd.org/public/rest/data/"
                "OECD.ELS.SAE,DSD_EARNINGS@AV_AN_WAGE,1.0"
            )
            series_id = f"AV_AN_WAGE.{ref_area}.WG.{unit_measure}.A.V.MEAN"
            rows.append([
                iso2,
                region,
                "mean_annual",
                ps.isoformat(),
                pe.isoformat(),
                str(year),
                "",
                str(val),
                currency,
                "",
                "OECD",
                src_url,
                series_id,
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
        f"INSERT INTO wages ({cols}) "
        f"SELECT {cols} FROM _stg_w ON CONFLICT (country, COALESCE(region,''), measure, period_start, source_authority) DO NOTHING;\n"
        "DROP TABLE _stg_w;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-q", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    return len(lines)


def main():
    log("=== Phase G OECD direct wages loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    log("Fetching AV_AN_WAGE (all countries, all years, all units) ...")
    payload = fetch()
    if not payload:
        log("FATAL: no payload")
        _signal_alert("ORBI Phase G OECD direct FAILED", "no payload")
        return
    rows = build_rows(payload, fetched_at)
    log(f"Built {len(rows)} candidate rows (nominal current prices only)")
    n = copy_rows(rows)
    if n >= 0:
        log(f"Staged {n} rows")
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase G OECD direct FAILED", str(e)[:200])
        sys.exit(1)
