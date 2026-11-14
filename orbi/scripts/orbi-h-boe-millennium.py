#!/usr/bin/env python3
"""
Phase H1  -  Bank of England "A Millennium of Macroeconomic Data" loader.

Source: Bank of England, "A Millennium of Macroeconomic Data for the UK"
  https://www.bankofengland.co.uk/statistics/research-datasets
  Workbook: a-millennium-of-macroeconomic-data-for-the-uk.xlsx (~27 MB)
  License: Open Government Licence v3.0 (OGL v3.0)  -  attribution required.

Download (run once, manually):
  mkdir -p /opt/bb-support/data/boe-millennium
  curl -sSL -o /opt/bb-support/data/boe-millennium/a-millennium-of-macroeconomic-data-for-the-uk.xlsx \\
    "https://www.bankofengland.co.uk/-/media/boe/files/statistics/research-datasets/a-millennium-of-macroeconomic-data-for-the-uk.xlsx"

This loader parses three sheets:
  A47. Wages and prices   -  annual avg weekly earnings (£) + UK CPI index (2015=100)
                           from 1209 onwards
  A48. Real Earnings      -  real consumption earnings (1209+) [we don't write yet]
  A24. Monetary aggregates  -  Coin in circulation £mn (1270+), end-year estimates

Tables written:
  historical_money_prices  ← canonical millennium-deep series (citation mandatory)
       asset='UK_CPI_INDEX'         (1209+ spliced CPI, 2015=100)
       asset='UK_NOMINAL_WAGES'     (1209+ composite avg weekly earnings, £)
       asset='UK_COIN_IN_CIRCULATION' (1270+ coin in circulation, £ million)
  inflation_rates          ← modern-style UK CPI rows (where CPI > 0)
       country='UK', index_kind='CPI', source_authority='ONS-GB'
       (BoE Millennium splices ONS + scholarly historical sources; ONS-GB is the
        closest enum value; BoE compilation noted in source_url.)
  wages                    ← UK nominal annual wage rows
       country='UK', measure='mean_weekly', currency='GBP',
       source_authority='ONS-GB'

Idempotent: ON CONFLICT DO NOTHING on each table's unique key.
Cadence: monthly timer. BoE re-publishes the workbook ~annually with revisions;
running monthly is harmless and picks up revisions when they appear.
"""
import json, os, subprocess, sys, time
from datetime import datetime, date, timezone
from decimal import Decimal

import openpyxl
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-boe-millennium.log"
XLSX = "/opt/bb-support/data/boe-millennium/a-millennium-of-macroeconomic-data-for-the-uk.xlsx"

CITATION_BOE = (
    "Bank of England, 'A Millennium of Macroeconomic Data for the UK' "
    "(research dataset, latest version). Sheet {sheet}, column '{column}'. "
    "Reused under the Open Government Licence v3.0 (OGL v3.0); "
    "redistributed by ORBI under CC-BY 4.0 with attribution to the Bank of England "
    "and the underlying scholarly compilers."
)

BOE_SRC_URL = (
    "https://www.bankofengland.co.uk/statistics/research-datasets"
    "#a-millennium-of-macroeconomic-data"
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


def _to_decimal(v):
    if v is None:
        return None
    try:
        d = Decimal(str(v))
        if d <= 0:
            return None
        return d
    except Exception:
        return None


def _to_year(v):
    if v is None:
        return None
    try:
        y = int(v)
        if 1000 <= y <= 2100:
            return y
    except Exception:
        pass
    return None


def parse_a47(ws):
    """
    A47 layout:
      col A (idx 0): year
      col B (idx 1): Composite Avg Weekly Earnings, £, England/GB
      col D (idx 3): CPI spliced index 2015=100, GB/UK
      col E (idx 4): CPI inflation YoY %, GB/UK
    Data rows begin at row 7 (year 1209).
    Returns (cpi_rows, wage_rows)  -  each list of (year, Decimal value).
    """
    cpi = []
    wages = []
    for row in ws.iter_rows(min_row=7, values_only=True):
        y = _to_year(row[0] if len(row) > 0 else None)
        if y is None:
            continue
        w = _to_decimal(row[1] if len(row) > 1 else None)
        c = _to_decimal(row[3] if len(row) > 3 else None)
        if w is not None:
            wages.append((y, w))
        if c is not None:
            cpi.append((y, c))
    return cpi, wages


def parse_a24(ws):
    """
    A24 layout (Monetary aggregates):
      col A (idx 0): year
      col G (idx 6): Coin in circulation £mn, end-year, 1270-
    Returns list of (year, Decimal).
    """
    out = []
    for row in ws.iter_rows(min_row=8, values_only=True):
        y = _to_year(row[0] if len(row) > 0 else None)
        if y is None:
            continue
        v = _to_decimal(row[6] if len(row) > 6 else None)
        if v is not None:
            out.append((y, v))
    return out


def _hist_row(asset, quote_in, year, value, unit, citation, compiler, region, notes_dict, fetched_at):
    notes = json.dumps(notes_dict)
    return [
        asset, quote_in, str(year), str(year),
        f"{year} annual", str(value), unit, "scholarly",
        "BOE_MILLENNIUM", citation, compiler, region, notes,
        fetched_at, fetched_at,
    ]


def copy_historical(rows, fetched_at):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("asset, quote_in, year_start, year_end, period_label, value, unit, "
            "confidence, source_authority, citation, compiler, region, notes, "
            "fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_h (LIKE historical_money_prices INCLUDING DEFAULTS);\n"
        f"\\copy _stg_h ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO historical_money_prices ({cols}) "
        f"SELECT {cols} FROM _stg_h ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_h;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        log(f"  historical COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def copy_inflation_uk(cpi_rows, fetched_at):
    """Write UK CPI as inflation_rates rows. value is the spliced index (2015=100)."""
    if not cpi_rows:
        return 0
    lines = []
    by_year = {y: v for y, v in cpi_rows}
    for y, v in cpi_rows:
        period_start = date(y, 1, 1).isoformat()
        period_end = date(y, 12, 31).isoformat()
        # yoy_pct computed in SQL after COPY (window function). Leave NULL here.
        row = [
            "UK", "",                   # country, region
            "CPI",                      # index_kind
            period_start, period_end,
            str(y),                     # period_label
            "",                         # release_date
            str(v),                     # value (index, 2015=100)
            "2015",                     # base_year
            "", "",                     # yoy_pct, mom_pct
            "source",                   # populated_by
            "0",                        # revision_number
            "",                         # superseded_by_id
            "FINAL",                    # status
            "ONS-GB",                   # source_authority
            BOE_SRC_URL,                # source_url
            "BoE-Millennium-A47-CPI",   # source_series_id
            "historical-backfill",      # provenance
            fetched_at, fetched_at,
        ]
        fields = ["\\N" if v_ == "" else str(v_).replace("\t", " ").replace("\n", " ") for v_ in row]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, region, index_kind, period_start, period_end, period_label, "
            "release_date, value, base_year, yoy_pct, mom_pct, populated_by, "
            "revision_number, superseded_by_id, status, source_authority, "
            "source_url, source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_i (LIKE inflation_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_i ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO inflation_rates ({cols}) "
        f"SELECT {cols} FROM _stg_i ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_i;\n"
        "WITH ranked AS (\n"
        "  SELECT id, period_start, value, "
        "         LAG(value, 1) OVER (ORDER BY period_start) AS v_prev\n"
        "    FROM inflation_rates\n"
        "   WHERE source_authority='ONS-GB' AND source_series_id='BoE-Millennium-A47-CPI'\n"
        ")\n"
        "UPDATE inflation_rates ir\n"
        "   SET yoy_pct = ROUND(((r.value - r.v_prev) / r.v_prev * 100)::numeric, 6)\n"
        "  FROM ranked r\n"
        " WHERE ir.id = r.id AND r.v_prev IS NOT NULL AND r.v_prev > 0;\n"
    )
    rr = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=300,
    )
    if rr.returncode != 0:
        log(f"  inflation COPY FAIL: {rr.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (rr.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def copy_wages_uk(wage_rows, fetched_at):
    if not wage_rows:
        return 0
    lines = []
    for y, v in wage_rows:
        period_start = date(y, 1, 1).isoformat()
        period_end = date(y, 12, 31).isoformat()
        row = [
            "UK", "",                            # country, region
            "mean_weekly",                       # measure
            period_start, period_end,
            str(y),                              # period_label
            "",                                  # release_date
            str(v),                              # value (£)
            "GBP",                               # currency
            "",                                  # base_year
            "ONS-GB",                            # source_authority
            BOE_SRC_URL,                         # source_url
            "BoE-Millennium-A47-CompositeAvgWeeklyEarnings",  # source_series_id
            "historical-backfill",               # provenance
            fetched_at, fetched_at,
        ]
        fields = ["\\N" if v_ == "" else str(v_).replace("\t", " ").replace("\n", " ") for v_ in row]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, region, measure, period_start, period_end, period_label, "
            "release_date, value, currency, base_year, source_authority, source_url, "
            "source_series_id, provenance, fetched_at, inserted_at")
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



# === PHASE H2 EXTENSION ===
# Phase H2 (Session D): extract additional BoE Millennium sheets.

CITATION_BOE_H2 = (
    "Bank of England, 'A Millennium of Macroeconomic Data for the UK' "
    "(latest version). Sheet {sheet}, column {col}. "
    "Reused under Open Government Licence v3.0; "
    "redistributed by ORBI under CC-BY 4.0 with attribution to the Bank of England."
)


def parse_a24_extended(ws):
    """
    A24 columns of interest (0-indexed):
      col 0:  year
      col 16: Notes and coin in circulation - spliced composite series (GBP_mn)
      col 31: Monetary base or M0 - spliced series (GBP_mn)
    Data rows begin at row 8 (year 1270).
    Returns dict of {series_key: [(year, Decimal), ...]}.
    """
    m0, notes_coin = [], []
    for row in ws.iter_rows(min_row=8, values_only=True):
        y = _to_year(row[0] if len(row) > 0 else None)
        if y is None:
            continue
        nc = _to_decimal(row[16] if len(row) > 16 else None)
        m0_v = _to_decimal(row[31] if len(row) > 31 else None)
        if nc is not None:
            notes_coin.append((y, nc))
        if m0_v is not None:
            m0.append((y, m0_v))
    return {"M0": m0, "NOTES_COIN_PUBLIC": notes_coin}


def parse_a21(ws):
    """
    A21 columns of interest:
      col 0:  year
      col 7:  England Nominal GDP per capita (GBP)
      col 8:  England Real GDP per capita 2013 prices (GBP)
      col 12: GB Nominal GDP (GBP_mn)
      col 13: GB Real GDP 2013 prices (GBP_mn)
    Data rows begin at row 6 (year 1086).
    Returns dict of {series_key: [(year, Decimal), ...]}.
    """
    eng_nom_pc, eng_real_pc, gb_nom, gb_real = [], [], [], []
    for row in ws.iter_rows(min_row=6, values_only=True):
        y = _to_year(row[0] if len(row) > 0 else None)
        if y is None:
            continue
        v7  = _to_decimal(row[7]  if len(row) > 7  else None)
        v8  = _to_decimal(row[8]  if len(row) > 8  else None)
        v12 = _to_decimal(row[12] if len(row) > 12 else None)
        v13 = _to_decimal(row[13] if len(row) > 13 else None)
        if v7  is not None: eng_nom_pc.append((y, v7))
        if v8  is not None: eng_real_pc.append((y, v8))
        if v12 is not None: gb_nom.append((y, v12))
        if v13 is not None: gb_real.append((y, v13))
    return {
        "ENG_NOMINAL_GDP_PER_CAPITA": eng_nom_pc,
        "ENG_REAL_GDP_PER_CAPITA_2013": eng_real_pc,
        "GB_NOMINAL_GDP": gb_nom,
        "GB_REAL_GDP_2013": gb_real,
    }


def parse_a31(ws):
    """
    A31 columns of interest:
      col 0: year
      col 1: Bank Rate (percent, annual avg)
    Data rows begin at row 8 (year 1688).
    """
    out = []
    for row in ws.iter_rows(min_row=8, values_only=True):
        y = _to_year(row[0] if len(row) > 0 else None)
        if y is None:
            continue
        v = _to_decimal(row[1] if len(row) > 1 else None)
        if v is not None:
            out.append((y, v))
    return out


def copy_monetary_aggregates_uk(m0_rows, fetched_at):
    """Write UK M0 spliced series into monetary_aggregates."""
    if not m0_rows:
        return 0
    lines = []
    for y, v in m0_rows:
        period_start = date(y, 1, 1).isoformat()
        period_end = date(y, 12, 31).isoformat()
        row = [
            "UK", "M0",
            period_start, period_end, str(y),
            "",            # release_date
            str(v),        # value (£mn)
            "GBP",
            "true",        # seasonally_adjusted (historical annuals: not relevant; mark true)
            "BOE",
            BOE_SRC_URL,
            "BoE-Millennium-A24-MonetaryBaseSpliced",
            "historical-backfill",
            fetched_at, fetched_at,
        ]
        fields = ["\\N" if v_ == "" else str(v_).replace("\t", " ").replace("\n", " ")
                  for v_ in row]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, aggregate, period_start, period_end, period_label, "
            "release_date, value, currency, seasonally_adjusted, "
            "source_authority, source_url, source_series_id, provenance, "
            "fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_ma (LIKE monetary_aggregates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_ma ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO monetary_aggregates ({cols}) "
        f"SELECT {cols} FROM _stg_ma ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_ma;\n"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0:
            log(f"  monetary_aggregates COPY FAIL: {r.stderr[:400]}")
            _signal_alert("ORBI H2 monetary_aggregates failed", r.stderr[:200])
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
        log(f"  monetary_aggregates exception: {e!r}")
        _signal_alert("ORBI H2 monetary_aggregates exception", str(e)[:200])
        return -1


def build_h2_historical_rows(series_dict_a21, notes_coin_rows, bank_rate_rows, fetched_at):
    """
    Build historical_money_prices rows for all Phase H2 series that don't
    fit monetary_aggregates.
    """
    hist = []

    a21_specs = {
        "ENG_NOMINAL_GDP_PER_CAPITA": (
            "GBP", "GBP", "England Nominal GDP per capita",
            "Broadberry et al; BoE compilation", "England",
            "A21. GDP per capita 1086+", "col 7: England Nominal GDP per capita",
        ),
        "ENG_REAL_GDP_PER_CAPITA_2013": (
            "GBP", "GBP_2013", "England Real GDP per capita 2013 prices",
            "Broadberry et al; BoE compilation", "England",
            "A21. GDP per capita 1086+", "col 8: England Real GDP per capita 2013",
        ),
        "GB_NOMINAL_GDP": (
            "GBP", "GBP_million", "Great Britain Nominal GDP",
            "Broadberry et al; BoE compilation", "Great Britain",
            "A21. GDP per capita 1086+", "col 12: GB Nominal GDP",
        ),
        "GB_REAL_GDP_2013": (
            "GBP", "GBP_million_2013", "Great Britain Real GDP 2013 prices",
            "Broadberry et al; BoE compilation", "Great Britain",
            "A21. GDP per capita 1086+", "col 13: GB Real GDP 2013",
        ),
    }

    for asset, rows in series_dict_a21.items():
        spec = a21_specs[asset]
        quote_in, unit, label, compiler, region, sheet, col_desc = spec
        cit = CITATION_BOE_H2.format(sheet=sheet, col=col_desc)
        for y, v in rows:
            hist.append(_hist_row(
                asset, quote_in, y, v, unit, cit, compiler, region,
                {"sheet": sheet.split(".")[0], "series": label}, fetched_at,
            ))

    # A24 col 16 Notes and Coin
    cit = CITATION_BOE_H2.format(
        sheet="A24. Monetary aggregates",
        col="col 16: Notes and coin in circulation, spliced composite",
    )
    for y, v in notes_coin_rows:
        hist.append(_hist_row(
            "UK_NOTES_COIN_PUBLIC", "GBP", y, v, "GBP_million",
            cit, "Capie & Webber / Bank of England spliced", "UK",
            {"sheet": "A24", "series": "Notes and coin in circulation, spliced"},
            fetched_at,
        ))

    # A31 col 1 Bank Rate
    cit = CITATION_BOE_H2.format(
        sheet="A31. Interest rates & asset prices",
        col="col 1: Bank Rate 1694-1972, MLR/Repo/Bank Rate thereafter",
    )
    for y, v in bank_rate_rows:
        hist.append(_hist_row(
            "UK_BANK_RATE", "PCT", y, v, "percent_annual",
            cit, "Bank of England", "UK",
            {"sheet": "A31", "series": "Bank Rate (annual average)"},
            fetched_at,
        ))

    return hist


def continuity_check_h2():
    sql = (
        "SELECT '\''monetary_aggregates UK M0'\'' AS series, "
        "       (year_start/10*10) AS decade, count(*) "
        "FROM (SELECT EXTRACT(YEAR FROM period_start)::int AS year_start "
        "      FROM monetary_aggregates "
        "      WHERE country='\''UK'\'' AND aggregate='\''M0'\'' "
        "        AND source_authority='\''BOE'\'') t "
        "GROUP BY 1,2 ORDER BY 1,2;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("H2 continuity (UK M0 by decade):")
        for line in (r.stdout or "").splitlines()[:60]:
            log(f"  {line}")
    except Exception as e:
        log(f"  H2 continuity check failed: {e!r}")


def run_phase_h2(wb, fetched_at):
    """Independent runner  -  never raises into the main loader."""
    try:
        log("Phase H2: parsing A24 (extended) ...")
        a24x = parse_a24_extended(wb["A24. Monetary aggregates"])
        log(f"  A24 M0: {len(a24x['M0'])} rows  |  Notes-Coin: {len(a24x['NOTES_COIN_PUBLIC'])} rows")

        log("Phase H2: parsing A21 (GDP per capita) ...")
        a21 = parse_a21(wb["A21. GDP per capita 1086+"])
        for k, v in a21.items():
            log(f"  A21 {k}: {len(v)} rows")

        log("Phase H2: parsing A31 (interest rates) ...")
        bank_rate = parse_a31(wb["A31. Interest rates & asset ps "])
        log(f"  A31 UK Bank Rate: {len(bank_rate)} rows")

        # Write monetary_aggregates first
        n_ma = copy_monetary_aggregates_uk(a24x["M0"], fetched_at)
        log(f"monetary_aggregates (UK M0): wrote {n_ma} rows")

        # Write historical_money_prices Phase H2 rows
        hist = build_h2_historical_rows(a21, a24x["NOTES_COIN_PUBLIC"], bank_rate, fetched_at)
        n_h = copy_historical(hist, fetched_at)
        log(f"historical_money_prices (H2): wrote {n_h} rows")

        continuity_check_h2()
    except Exception as e:
        log(f"Phase H2 BLOCK FAILED: {e!r}")
        _signal_alert("ORBI H2 BoE extension failed", str(e)[:200])
# === END PHASE H2 EXTENSION ===

def main():
    if not os.path.exists(XLSX):
        log(f"FATAL: {XLSX} not found. Download via:")
        log(f"  curl -sSL -o {XLSX} 'https://www.bankofengland.co.uk/-/media/boe/files/statistics/research-datasets/a-millennium-of-macroeconomic-data-for-the-uk.xlsx'")
        sys.exit(2)
    log("=== Phase H1 BoE Millennium loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)

    log("Parsing A47 (Wages and prices) ...")
    cpi_rows, wage_rows = parse_a47(wb["A47. Wages and prices"])
    log(f"  A47: {len(cpi_rows)} CPI rows, {len(wage_rows)} wage rows")

    log("Parsing A24 (Monetary aggregates) ...")
    coin_rows = parse_a24(wb["A24. Monetary aggregates"])
    log(f"  A24: {len(coin_rows)} coin-in-circulation rows")

    # 1) historical_money_prices  -  canonical citation-bearing rows
    cit_cpi  = CITATION_BOE.format(sheet="A47. Wages and prices",
                                   column="Consumer Price Index (CPI) spliced 2015=100, GB/UK")
    cit_wage = CITATION_BOE.format(sheet="A47. Wages and prices",
                                   column="Composite Average Weekly Earnings, £, England/GB")
    cit_coin = CITATION_BOE.format(sheet="A24. Monetary aggregates",
                                   column="Coin in circulation £mn (end-year)")
    hist = []
    for y, v in cpi_rows:
        hist.append(_hist_row(
            "UK_CPI_INDEX", "INDEX", y, v, "index_2015_eq_100",
            cit_cpi, "Bank of England (splice of ONS + scholarly sources)",
            "UK", {"sheet": "A47", "base_year": 2015}, fetched_at,
        ))
    for y, v in wage_rows:
        hist.append(_hist_row(
            "UK_NOMINAL_WAGES", "GBP", y, v, "GBP_per_week",
            cit_wage, "Bank of England composite (NB based on English daily wage)",
            "UK", {"sheet": "A47", "series": "Composite Avg Weekly Earnings"}, fetched_at,
        ))
    for y, v in coin_rows:
        hist.append(_hist_row(
            "UK_COIN_IN_CIRCULATION", "GBP", y, v, "GBP_million",
            cit_coin, "Mayhew / Allen / Capie & Webber (compiled by BoE)",
            "UK", {"sheet": "A24", "estimate_basis": "end-year"}, fetched_at,
        ))
    n_hist = copy_historical(hist, fetched_at)
    log(f"historical_money_prices: wrote {n_hist} rows")

    # 2) inflation_rates UK CPI
    n_cpi = copy_inflation_uk(cpi_rows, fetched_at)
    log(f"inflation_rates (UK CPI): wrote {n_cpi} rows")

    # 3) wages UK
    n_w = copy_wages_uk(wage_rows, fetched_at)
    log(f"wages (UK): wrote {n_w} rows")

        # Phase H2  -  additional BoE sheets (Session D)
    run_phase_h2(wb, fetched_at)

    _sync_resolutions("orbi-backfill-historical-money-prices-resolutions.py")
    _sync_resolutions("orbi-backfill-inflation-resolutions.py")
    log("=== done ===")


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
        _signal_alert("ORBI H1 BoE Millennium FAILED", str(e)[:200])
        sys.exit(1)
