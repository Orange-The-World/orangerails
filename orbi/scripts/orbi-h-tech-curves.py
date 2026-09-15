#!/usr/bin/env python3
"""
Phase G  -  Tech Productivity Curves loader.

Loads cost-per-unit time series for the Wright's-law / "Price of Tomorrow"
deflation-vs-fiat narrative. Targets table `tech_productivity_curves`.

ToS deep-dive (verbatim quotes, per-source verdicts):
  https://wiki.abascal.ca  →  "Phase G  -  Tech Productivity Curves"

Sources loaded:
  - NREL Annual Technology Baseline 2024 (GO; allowlist authority='NREL')
       Utility-scale Solar PV CapEx ($/W_AC)
       Land-based Wind CapEx ($/kW)
       Utility-scale Li-ion Battery Storage CapEx ($/kWh)

Sources GATED (allowlist gap; founder decision pending):
  - NIH NHGRI sequencing costs ($/genome)  -  code present, ENABLED=False.
    Authority value 'NIH_NHGRI' not in tech_productivity_curves_source_authority_check.

Sources DEFERRED to Phase G2:
  - Our World in Data (CC-BY 4.0 for OWID-original; underlying third-party
    series need individual verification).

Brittleness-safe:
  - Every DB call wrapped in try/except; failures Signal-alerted, never re-raised.
  - Sources are independent: a failure in one does not block the others.

Cadence: annual timer (orbi-h-tech-curves.timer). These series update yearly
at most; running monthly would just hit the same numbers.
"""
import json, os, subprocess, sys
from datetime import datetime, date, timezone
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-tech-curves.log"

# Allowlist flag  -  flip True once NIH_NHGRI is added to the CHECK constraint.
NHGRI_ENABLED = False

NREL_CITATION = (
    "NREL (National Renewable Energy Laboratory). 2024. "
    "'2024 Annual Technology Baseline.' Golden, CO: NREL. "
    "Data provided AS IS under DOE Contract DE-AC36-08GO28308. "
    "https://atb.nrel.gov/electricity/2024/data"
)

NHGRI_CITATION = (
    "National Human Genome Research Institute (NHGRI), 'DNA Sequencing Costs: "
    "Data from the NHGRI Genome Sequencing Program (GSP).' Public domain "
    "(NHGRI Copyright Policy, US Government work). "
    "https://www.genome.gov/about-genomics/fact-sheets/Sequencing-Human-Genome-cost"
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


# -----------------------------------------------------------------------------
# NREL ATB 2024  -  moderate-case CapEx, published values
#
# Source: https://atb.nrel.gov/electricity/2024/data  (Moderate scenario,
# CapEx, all years). Values reproduced here are the published ATB 2024
# moderate-case figures for the technologies and years listed. Hard-coded
# rather than scraped: ATB publishes annually and values are stable
# year-over-year for already-published rows.
#
# Units:
#   Solar PV utility-scale: $/W_AC (CapEx, including installation)
#   Land-based wind: $/kW (CapEx)
#   Li-ion battery storage 4-hr utility: $/kWh (CapEx, battery + BoP)
# -----------------------------------------------------------------------------
NREL_ATB_2024_MODERATE = [
    # (item, metric, year, value, unit, learning_notes)
    # Utility-scale solar PV CapEx ($/W_AC)  -  ATB 2024 moderate, system-level
    ("Solar PV (utility-scale)", "CapEx", 2019, 1.31, "USD_per_W_AC"),
    ("Solar PV (utility-scale)", "CapEx", 2020, 1.20, "USD_per_W_AC"),
    ("Solar PV (utility-scale)", "CapEx", 2021, 1.13, "USD_per_W_AC"),
    ("Solar PV (utility-scale)", "CapEx", 2022, 1.21, "USD_per_W_AC"),
    ("Solar PV (utility-scale)", "CapEx", 2023, 1.16, "USD_per_W_AC"),
    ("Solar PV (utility-scale)", "CapEx", 2024, 1.13, "USD_per_W_AC"),
    # Land-based wind CapEx ($/kW)  -  ATB 2024 moderate, Class 4 reference
    ("Wind (land-based)", "CapEx", 2019, 1593, "USD_per_kW"),
    ("Wind (land-based)", "CapEx", 2020, 1478, "USD_per_kW"),
    ("Wind (land-based)", "CapEx", 2021, 1394, "USD_per_kW"),
    ("Wind (land-based)", "CapEx", 2022, 1462, "USD_per_kW"),
    ("Wind (land-based)", "CapEx", 2023, 1451, "USD_per_kW"),
    ("Wind (land-based)", "CapEx", 2024, 1428, "USD_per_kW"),
    # Utility-scale Li-ion 4-hr battery storage CapEx ($/kWh)  -  ATB 2024 moderate
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2019, 380, "USD_per_kWh"),
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2020, 322, "USD_per_kWh"),
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2021, 281, "USD_per_kWh"),
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2022, 308, "USD_per_kWh"),
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2023, 273, "USD_per_kWh"),
    ("Battery storage (Li-ion utility 4hr)", "CapEx", 2024, 252, "USD_per_kWh"),
]

NREL_SOURCE_URL = "https://atb.nrel.gov/electricity/2024/data"


# -----------------------------------------------------------------------------
# NHGRI sequencing costs ($/genome)  -  public domain, but allowlist-gated.
# Selected published anchor years from NHGRI's "Sequencing_Cost_Data_Table".
# (Hard-coded; can be replaced with XLS pull once gating lifted.)
# -----------------------------------------------------------------------------
NHGRI_PER_GENOME = [
    # (year-month, value USD)
    (2001,  9, 95263072),
    (2002,  9, 70175437),
    (2003, 10, 50898362),
    (2004, 10, 26721175),
    (2005, 10, 23730539),
    (2006, 10, 14935169),
    (2007, 10, 10000064),
    (2008,  1,  3063820),   # transition to next-gen sequencing
    (2009,  1,    340000),
    (2010,  1,     46774),
    (2011,  1,     20963),
    (2012,  1,      7666),
    (2013,  1,      5901),
    (2014,  1,      4920),
    (2015,  7,      1245),
    (2016,  7,      1121),
    (2017,  7,      1121),
    (2018,  7,      1083),
    (2019,  7,       942),
    (2020,  7,       689),
    (2021,  7,       562),
    (2022,  4,       525),
]

NHGRI_SOURCE_URL = (
    "https://www.genome.gov/about-genomics/fact-sheets/"
    "Sequencing-Human-Genome-cost"
)


# -----------------------------------------------------------------------------
# DB writer (psql COPY)  -  brittleness-safe
# -----------------------------------------------------------------------------
def _copy_tech_curves(rows, fetched_at):
    """
    rows: list of tuples
      (item, metric, period_start_iso, period_end_iso, value, unit,
       currency, source_authority, source_url, notes, citation)
    """
    if not rows:
        return 0
    lines = []
    for r in rows:
        item, metric, ps, pe, value, unit, currency, sa, surl, notes, _cit = r
        # citation is folded into notes since tech_productivity_curves
        # has no dedicated citation column. Schema check confirmed.
        notes_full = f"{notes} | citation: {_cit}"
        fields = [
            item, metric, ps, pe, str(value), unit, currency,
            "", "",  # cumulative_production, _unit (NULL)
            sa, surl, notes_full,
            fetched_at, fetched_at,
        ]
        clean = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ")
                 for v in fields]
        lines.append("\t".join(clean))
    data = "\n".join(lines) + "\n"
    cols = ("item, metric, period_start, period_end, value, unit, currency, "
            "cumulative_production, cumulative_production_unit, "
            "source_authority, source_url, notes, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_tc (LIKE tech_productivity_curves INCLUDING DEFAULTS);\n"
        f"\\copy _stg_tc ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO tech_productivity_curves ({cols}) "
        f"SELECT {cols} FROM _stg_tc ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_tc;\n"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0:
            log(f"  COPY FAIL: {r.stderr[:400]}")
            _signal_alert("ORBI tech-curves COPY failed", r.stderr[:200])
            return -1
        _wrote = len(lines)
        _out = (r.stdout or "").strip().splitlines()
        if _out:
            try:
                _wrote = int(_out[-1])
            except ValueError:
                log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
        return _wrote
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI tech-curves COPY exception", str(e)[:200])
        return -1


# -----------------------------------------------------------------------------
# Builders per source  -  each returns a list of rows ready for _copy_tech_curves
# -----------------------------------------------------------------------------
def build_nrel_rows(fetched_at):
    out = []
    for item, metric, year, value, unit in NREL_ATB_2024_MODERATE:
        ps = date(year, 1, 1).isoformat()
        pe = date(year, 12, 31).isoformat()
        notes = (
            "ATB 2024 moderate scenario. Cost AS-IS per NREL disclaimer. "
            "Inspired by 'The Price of Tomorrow' (Booth)  -  deflationary "
            "tech curves vs fiat dilution."
        )
        out.append((
            item, metric, ps, pe, value, unit, "USD",
            "NREL", NREL_SOURCE_URL, notes, NREL_CITATION,
        ))
    return out


def build_nhgri_rows(fetched_at):
    if not NHGRI_ENABLED:
        log("NHGRI sequencing: GATED (allowlist gap, see Phase G ToS doc).")
        return []
    out = []
    for year, month, value in NHGRI_PER_GENOME:
        ps = date(year, month, 1).isoformat()
        pe = date(year, month, 1).isoformat()
        notes = (
            "NHGRI Genome Sequencing Program cost benchmark. Public domain "
            "(US Govt work). 2008 step-change = Sanger to next-gen platforms. "
            "Inspired by 'The Price of Tomorrow' (Booth)  -  the canonical "
            "Wright's-law curve."
        )
        out.append((
            "DNA sequencing (human genome)", "Cost per genome",
            ps, pe, value, "USD_per_genome", "USD",
            "NIH_NHGRI", NHGRI_SOURCE_URL, notes, NHGRI_CITATION,
        ))
    return out


# -----------------------------------------------------------------------------
# Continuity check  -  per-source row count summary
# -----------------------------------------------------------------------------
def continuity_check():
    sql = (
        "SELECT source_authority, item, count(*) AS n, "
        "min(period_start) AS first_yr, max(period_start) AS last_yr "
        "FROM tech_productivity_curves "
        "GROUP BY 1,2 ORDER BY 1,2;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (tech_productivity_curves):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def main():
    log("=== Phase G tech-curves loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()

    total = 0
    # NREL
    try:
        rows = build_nrel_rows(fetched_at)
        n = _copy_tech_curves(rows, fetched_at)
        log(f"NREL ATB 2024: wrote {n} rows ({len(rows)} prepared)")
        if n > 0:
            total += n
    except Exception as e:
        log(f"NREL block FAILED: {e!r}")
        _signal_alert("ORBI tech-curves NREL block failed", str(e)[:200])

    # NHGRI
    try:
        rows = build_nhgri_rows(fetched_at)
        if rows:
            n = _copy_tech_curves(rows, fetched_at)
            log(f"NHGRI sequencing: wrote {n} rows ({len(rows)} prepared)")
            if n > 0:
                total += n
    except Exception as e:
        log(f"NHGRI block FAILED: {e!r}")
        _signal_alert("ORBI tech-curves NHGRI block failed", str(e)[:200])

    log(f"Total wrote this run: {total}")
    continuity_check()
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI tech-curves FAILED", str(e)[:200])
        sys.exit(1)
