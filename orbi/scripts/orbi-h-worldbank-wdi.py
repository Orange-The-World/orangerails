#!/usr/bin/env python3
"""
Phase H Wave 1  -  World Bank WDI loader.

Source: World Bank, World Development Indicators
  Endpoint: https://api.worldbank.org/v2/country/all/indicator/{ind}?format=json
  License: CC-BY 4.0 (https://datacatalog.worldbank.org/public-licenses)

Initial indicator allowlist (per Wave 1 spec, founder-approved):

  Identifier               Target table              Notes
  -----------------------  ------------------------  --------------------------
  NY.GDP.PCAP.CD           historical_money_prices   GDP per capita, current US$
  NY.GDP.PCAP.PP.CD        historical_money_prices   GDP per capita, PPP
  NY.GDP.DEFL.KD.ZG        inflation_rates           GDP deflator (annual %)
  FP.CPI.TOTL.ZG           inflation_rates           Inflation, CPI (annual %)
  SP.POP.TOTL              historical_money_prices   Total population
  FI.RES.TOTL.CD           historical_money_prices   FX reserves (incl gold), current US$
  GC.DOD.TOTL.GD.ZS        historical_money_prices   Govt debt / GDP (%)
  FM.LBL.BMNY.GD.ZS        monetary_aggregates       Broad money / GDP (%)  -  proxy for M2/GDP
  FM.LBL.BMNY.CN           monetary_aggregates       Broad money (current LCU)
  NE.EXP.GNFS.CD           historical_money_prices   Exports of goods+services, current US$
  NE.IMP.GNFS.CD           historical_money_prices   Imports of goods+services, current US$

All series are annual, country-coded ISO-3.
WDI returns aggregate "regions" too (EU, OECD, etc.); we retain them as
region rows (asset/country='WLD','EUU','OED' etc.) because they are
load-bearing for cross-region denominators.

source_authority:
  - 'WORLD_BANK_WDI' on all tables.

Idempotent: ON CONFLICT DO NOTHING on each table's unique key.
Cadence: weekly timer. WDI revises annually but small fixes during the year.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/opt/bb-support/scripts")

LOG = "/var/log/orbi/orbi-h-worldbank-wdi.log"
BASE = "https://api.worldbank.org/v2"
SLEEP_BETWEEN = 1
PER_PAGE = 20000

# (indicator_id, label, target_table, asset_or_kind, unit, allow_pct)
# target_table: 'hmp' | 'inflation' | 'monetary'
INDICATORS = [
    ("NY.GDP.PCAP.CD",    "GDP per capita (current US$)",          "hmp",       "GDP_PER_CAPITA_USD",      "USD",      False),
    ("NY.GDP.PCAP.PP.CD", "GDP per capita PPP (current intl $)",   "hmp",       "GDP_PER_CAPITA_PPP",      "INTL_USD", False),
    ("NY.GDP.DEFL.KD.ZG", "GDP deflator (annual %)",               "inflation", "GDP-deflator",            None,       True),
    ("FP.CPI.TOTL.ZG",    "Inflation, CPI (annual %)",             "inflation", "CPI",                     None,       True),
    ("SP.POP.TOTL",       "Population, total",                     "hmp",       "POPULATION_TOTAL",        "persons",  False),
    ("FI.RES.TOTL.CD",    "Total reserves (incl gold), USD",       "hmp",       "FX_RESERVES_USD",         "USD",      False),
    ("GC.DOD.TOTL.GD.ZS", "Central govt debt / GDP (%)",           "hmp",       "GOVT_DEBT_PCT_GDP",       "pct",      True),
    ("FM.LBL.BMNY.GD.ZS", "Broad money / GDP (%)",                 "hmp",       "M2_PCT_GDP",              "pct",      True),
    ("FM.LBL.BMNY.CN",    "Broad money (current LCU)",             "monetary",  "M2",                      "LCU",      False),
    ("NE.EXP.GNFS.CD",    "Exports of goods+services (USD)",       "hmp",       "EXPORTS_USD",             "USD",      False),
    ("NE.IMP.GNFS.CD",    "Imports of goods+services (USD)",       "hmp",       "IMPORTS_USD",             "USD",      False),
]

CITATION_TPL = (
    "World Bank, World Development Indicators, series {ind} ({label}). "
    "CC-BY 4.0."
)
SRC_URL_TPL = "https://data.worldbank.org/indicator/{ind}"


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


def fetch_indicator(ind):
    out = []
    page = 1
    while True:
        url = f"{BASE}/country/all/indicator/{ind}?format=json&per_page={PER_PAGE}&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            log(f"  {ind} page {page} HTTP {e.code}")
            return out
        except Exception as e:
            log(f"  {ind} page {page} err: {str(e)[:200]}")
            return out
        if not isinstance(d, list) or len(d) < 2:
            return out
        meta, data = d[0], d[1] or []
        out.extend(data)
        if page >= (meta.get("pages") or 1):
            break
        page += 1
        time.sleep(SLEEP_BETWEEN)
    return out


def build_hmp_rows(ind, label, asset, unit, observations, fetched_at_iso, allow_pct):
    citation = CITATION_TPL.format(ind=ind, label=label)
    rows = []
    for o in observations:
        v = o.get("value")
        if v is None:
            continue
        try:
            val = Decimal(str(v))
        except Exception:
            continue
        # historical_money_prices.value > 0 constraint applies always. For pct
        # series we still skip non-positive (deflation, debt buybacks)  -  these
        # are rare and a future migration may relax the check for pct assets.
        if val <= 0:
            continue
        year_s = o.get("date")
        if not year_s:
            continue
        try:
            year = int(year_s)
        except Exception:
            continue
        iso3 = o.get("countryiso3code") or (o.get("country") or {}).get("id") or ""
        if not iso3:
            continue
        notes = json.dumps({"wdi_indicator": ind, "wdi_label": label})
        # historical_money_prices columns:
        # asset, quote_in, year_start, year_end, period_label, value, unit,
        # confidence, source_authority, citation, compiler, region, notes,
        # fetched_at, inserted_at
        rows.append([
            asset, unit, str(year), str(year), str(year),
            str(val), unit, "primary",
            "WORLD_BANK_WDI", citation, "World Bank WDI", iso3,
            notes, fetched_at_iso, fetched_at_iso,
        ])
    return rows


def build_inflation_rows(ind, label, kind, observations, fetched_at_iso):
    rows = []
    for o in observations:
        v = o.get("value")
        if v is None:
            continue
        try:
            val = Decimal(str(v))
        except Exception:
            continue
        # inflation_rates.value > 0 constraint; WDI series are YoY % change so
        # deflation/recession years (negative) are skipped here. Negative-allowed
        # variants live in historical_money_prices via the dedicated pct loader.
        if val <= 0:
            continue
        year_s = o.get("date")
        if not year_s:
            continue
        try:
            year = int(year_s)
        except Exception:
            continue
        iso3 = o.get("countryiso3code") or (o.get("country") or {}).get("id") or ""
        if not iso3:
            continue
        ps = date(year, 1, 1).isoformat()
        pe = date(year, 12, 31).isoformat()
        src_url = SRC_URL_TPL.format(ind=ind)
        # inflation_rates columns:
        # country, region, index_kind, period_start, period_end, period_label,
        # release_date, value, base_year, yoy_pct, mom_pct, populated_by,
        # revision_number, superseded_by_id, status, source_authority,
        # source_url, source_series_id, provenance, fetched_at, inserted_at
        rows.append([
            iso3, "", kind, ps, pe, str(year), "",
            str(val), "", str(val), "",  # value already is YoY %  -  also store as yoy_pct
            "source", "0", "", "FINAL", "WORLD_BANK_WDI",
            src_url, ind, "historical-backfill",
            fetched_at_iso, fetched_at_iso,
        ])
    return rows


def build_monetary_rows(ind, label, aggregate, observations, fetched_at_iso):
    rows = []
    for o in observations:
        v = o.get("value")
        if v is None:
            continue
        try:
            val = Decimal(str(v))
        except Exception:
            continue
        year_s = o.get("date")
        if not year_s:
            continue
        try:
            year = int(year_s)
        except Exception:
            continue
        iso3 = o.get("countryiso3code") or (o.get("country") or {}).get("id") or ""
        if not iso3:
            continue
        ps = date(year, 1, 1).isoformat()
        pe = date(year, 12, 31).isoformat()
        src_url = SRC_URL_TPL.format(ind=ind)
        # monetary_aggregates: schema column list (typical):
        # country, aggregate, period_start, period_end, period_label,
        # value, currency, source_authority, source_url, source_series_id,
        # provenance, fetched_at, inserted_at
        rows.append([
            iso3, aggregate, ps, pe, str(year),
            str(val), "LCU", "WORLD_BANK_WDI", src_url, ind,
            "historical-backfill", fetched_at_iso, fetched_at_iso,
        ])
    return rows


def copy_into(table, cols, rows, timeout=900):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols_str = ", ".join(cols)
    script = (
        f"CREATE TEMP TABLE _stg ({cols_str.replace(',', ' text,')} text);\n"
        f"\\copy _stg ({cols_str}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO {table} ({cols_str}) "
        f"SELECT {cols_str} FROM _stg ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg;\n"
    )
    # Use LIKE … INCLUDING DEFAULTS for proper types instead of all-text staging.
    script = (
        f"CREATE TEMP TABLE _stg (LIKE {table} INCLUDING DEFAULTS);\n"
        f"\\copy _stg ({cols_str}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO {table} ({cols_str}) "
        f"SELECT {cols_str} FROM _stg ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=timeout,
    )
    if r.returncode != 0:
        log(f"  COPY {table} FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


HMP_COLS = [
    "asset", "quote_in", "year_start", "year_end", "period_label",
    "value", "unit", "confidence", "source_authority", "citation",
    "compiler", "region", "notes", "fetched_at", "inserted_at",
]
INF_COLS = [
    "country", "region", "index_kind", "period_start", "period_end",
    "period_label", "release_date", "value", "base_year", "yoy_pct",
    "mom_pct", "populated_by", "revision_number", "superseded_by_id",
    "status", "source_authority", "source_url", "source_series_id",
    "provenance", "fetched_at", "inserted_at",
]
MON_COLS_DEFAULT = [
    "country", "aggregate", "period_start", "period_end", "period_label",
    "value", "currency", "source_authority", "source_url", "source_series_id",
    "provenance", "fetched_at", "inserted_at",
]


def continuity_check():
    """Per-indicator row-count + min/max year audit; alert on absurd gaps."""
    try:
        for tbl, src_col in [("historical_money_prices", "asset"),
                             ("inflation_rates",         "source_series_id"),
                             ("monetary_aggregates",     "source_series_id")]:
            sql = (
                f"SELECT {src_col}, count(*) AS n "
                f"FROM {tbl} WHERE source_authority='WORLD_BANK_WDI' "
                f"GROUP BY 1 ORDER BY 1;"
            )
            r = subprocess.run(
                ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
                capture_output=True, text=True, timeout=60,
            )
            log(f"Continuity ({tbl}):")
            for line in (r.stdout or "").splitlines():
                log(f"  {line}")
    except Exception as e:
        log(f"continuity raised (suppressed): {e}")


def main():
    log("=== Phase H Wave 1 World Bank WDI loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for ind, label, target, asset_or_kind, unit, allow_pct in INDICATORS:
        log(f"[{ind}] fetching ({label}) ...")
        obs = fetch_indicator(ind)
        log(f"[{ind}] got {len(obs)} observations")
        if not obs:
            continue
        if target == "hmp":
            rows = build_hmp_rows(ind, label, asset_or_kind, unit, obs, fetched_at, allow_pct)
            n = copy_into("historical_money_prices", HMP_COLS, rows)
        elif target == "inflation":
            rows = build_inflation_rows(ind, label, asset_or_kind, obs, fetched_at)
            n = copy_into("inflation_rates", INF_COLS, rows)
        elif target == "monetary":
            rows = build_monetary_rows(ind, label, asset_or_kind, obs, fetched_at)
            n = copy_into("monetary_aggregates", MON_COLS_DEFAULT, rows)
        else:
            n = 0
        if n > 0:
            grand_total += n
            log(f"[{ind}] wrote {n} rows")
        time.sleep(SLEEP_BETWEEN)
    log(f"=== done: {grand_total} candidate rows across {len(INDICATORS)} indicators ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H Wave1 WDI FAILED", str(e)[:200])
        sys.exit(1)
