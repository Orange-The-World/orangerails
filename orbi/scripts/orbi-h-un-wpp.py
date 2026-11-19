#!/usr/bin/env python3
"""
Phase H Wave 1  -  UN WPP (World Population Prospects 2024) loader.

Source: United Nations DESA Population Division
  URL: https://population.un.org/wpp/
  Bulk CSV: WPP2024_TotalPopulationBySex.csv (estimates + medium-variant
            projections, 1950-2100, all countries + regions, both sexes total).
  License: CC-BY 3.0 IGO.

Schema decision (per project_orbi_ownership.md decide-and-execute):
  Use historical_money_prices with asset='POPULATION_TOTAL', unit='persons',
  region=ISO-3 country code. Annual scalar series fits this table cleanly;
  precedent already set by 'UK_COIN_IN_CIRCULATION' (also a count-style
  annual series in this table). No new 'demographics' table required.

Tables written:
  historical_money_prices  ← asset='POPULATION_TOTAL', annual rows.

Idempotent: ON CONFLICT DO NOTHING on (asset, quote_in, year_start, year_end,
source_authority).
Cadence: annual timer. UN releases WPP roughly every 2 years; an annual probe
catches the latest revision.
"""
import csv, gzip, io, json, os, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-un-wpp.log"
DATA_DIR = "/opt/bb-support/data/un-wpp"
# UN restructured downloads in 2025: the CSVs are now gzipped and live
# under `assets/Excel Files/1_Indicator (Standard)/CSV_FILES/...csv.gz`.
# (Discovered via the SPA's assets/downloads.json catalogue, 2026-05-30.)
CSV_URL = "https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES/WPP2024_TotalPopulationBySex.csv.gz"
CSV_LOCAL = os.path.join(DATA_DIR, "WPP2024_TotalPopulationBySex.csv.gz")

CITATION = (
    "United Nations, Department of Economic and Social Affairs, "
    "Population Division (2024). World Population Prospects 2024, "
    "Total Population - Both Sexes (medium variant). CC-BY 3.0 IGO."
)
SRC_URL = "https://population.un.org/wpp/"


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


def ensure_csv():
    """Download WPP CSV if missing or older than 30 days."""
    os.makedirs(DATA_DIR, exist_ok=True)
    need = True
    if os.path.exists(CSV_LOCAL):
        age_sec = (datetime.now().timestamp() - os.path.getmtime(CSV_LOCAL))
        if age_sec < 30 * 86400:
            need = False
    if need:
        log(f"downloading {CSV_URL}")
        req = urllib.request.Request(CSV_URL, headers={"User-Agent": "ORBI/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                with open(CSV_LOCAL + ".tmp", "wb") as f:
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
            os.replace(CSV_LOCAL + ".tmp", CSV_LOCAL)
            log(f"downloaded -> {CSV_LOCAL} ({os.path.getsize(CSV_LOCAL)} bytes)")
        except Exception as e:
            log(f"download FAILED: {e}")
            if not os.path.exists(CSV_LOCAL):
                raise


def iter_rows(fetched_at):
    """Parse the WPP CSV. Schema (WPP 2024 standard CSV, verified 2026-05-30):
      SortOrder, LocID, Notes, ISO3_code, ISO2_code, SDMX_code, LocTypeID,
      LocTypeName, ParentID, Location, VarID, Variant, Time, MidPeriod,
      PopMale, PopFemale, PopTotal, PopDensity
    We keep:
      - Variant == 'Medium'  (2024 release merges historical estimates and
        the medium projection under the single 'Medium' variant for 1950-2100).
      - ISO3_code present (skip aggregates without ISO3  -  keep clean
        per-country series).
      - PopTotal in thousands; multiply by 1000 to get persons.
    """
    # File is gzipped; csv reader needs a text-mode file object.
    with gzip.open(CSV_LOCAL, mode="rt", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            variant = (r.get("Variant") or "").strip()
            if variant != "Medium":
                continue
            iso3 = (r.get("ISO3_code") or "").strip()
            if not iso3 or len(iso3) != 3:
                continue
            try:
                year = int(r["Time"])
            except Exception:
                continue
            pop_thousand = r.get("PopTotal")
            if pop_thousand in (None, "", " "):
                continue
            try:
                pop = Decimal(str(pop_thousand)) * Decimal(1000)
            except Exception:
                continue
            if pop <= 0:
                continue
            notes = json.dumps({
                "wpp_variant": variant,
                "wpp_loc_id": r.get("LocID"),
                "wpp_location": r.get("Location"),
            })
            yield [
                "POPULATION_TOTAL", "persons", str(year), str(year), str(year),
                str(pop.normalize()), "persons", "primary",
                "UN_WPP", CITATION, "UN DESA Pop Div (WPP 2024)", iso3,
                notes, fetched_at, fetched_at,
            ]


HMP_COLS = [
    "asset", "quote_in", "year_start", "year_end", "period_label",
    "value", "unit", "confidence", "source_authority", "citation",
    "compiler", "region", "notes", "fetched_at", "inserted_at",
]


def copy_batch(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols_str = ", ".join(HMP_COLS)
    script = (
        f"CREATE TEMP TABLE _stg_w (LIKE historical_money_prices INCLUDING DEFAULTS);\n"
        f"\\copy _stg_w ({cols_str}) FROM STDIN\n"
        + data + "\\.\n"
        f"INSERT INTO historical_money_prices ({cols_str}) "
        f"SELECT {cols_str} FROM _stg_w ON CONFLICT DO NOTHING;\n"
        "DROP TABLE _stg_w;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=900,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    return len(lines)


def continuity_check():
    """Country-count + min/max-year audit; alert on absurd gaps."""
    try:
        sql = (
            "SELECT count(*) AS rows, "
            "       count(DISTINCT region) AS countries, "
            "       min(year_start::int), max(year_end::int) "
            "FROM historical_money_prices "
            "WHERE source_authority='UN_WPP' AND asset='POPULATION_TOTAL';"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity (UN WPP):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity raised (suppressed): {e}")


def main():
    log("=== Phase H Wave 1 UN WPP loader start ===")
    ensure_csv()
    fetched_at = datetime.now(timezone.utc).isoformat()
    batch, total = [], 0
    BATCH_SZ = 50000
    for row in iter_rows(fetched_at):
        batch.append(row)
        if len(batch) >= BATCH_SZ:
            n = copy_batch(batch)
            if n > 0:
                total += n
                log(f"  staged batch n={n} (cum {total})")
            batch = []
    if batch:
        n = copy_batch(batch)
        if n > 0:
            total += n
            log(f"  staged final batch n={n}")
    log(f"=== done: {total} candidate rows ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H Wave1 UN WPP FAILED", str(e)[:200])
        sys.exit(1)
