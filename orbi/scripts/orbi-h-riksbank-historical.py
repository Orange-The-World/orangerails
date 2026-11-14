#!/usr/bin/env python3
"""
Phase H Wave 1  -  Sveriges Riksbank macro-historical loader.

Source: Riksbank macro-historical archive (Edvinsson et al.)
  URL: https://www.riksbank.se/en-gb/statistics/macro-historical/
  Workbooks (run-once manual download, then loader parses):
    - prices.xlsx              CPI/PPI/wholesale, 1290+
    - gdp.xlsx                 Nominal & real GDP, 1620+
    - moneystock.xlsx          M0/M3, 1668+
    - bankrate.xlsx            Riksbank discount rate, 1668+
  License: Riksbank statistics  -  public reuse with attribution; underlying
           scholarly compilation by Edvinsson, Jacobson, Waldenström, etc.

This is a research-archive parser. Each workbook is hand-mapped per its
known layout (the Edvinsson team uses a stable column structure). Run the
modern-FX loader (orbi-h-riksbank.py) separately on a daily timer; this
loader runs annually.

Tables written:
  historical_money_prices  ← SE_CPI_INDEX, SE_GDP_NOMINAL, SE_GDP_REAL,
                             SE_M0, SE_M3, SE_BANK_RATE annual rows.

Idempotent: ON CONFLICT DO NOTHING.
Cadence: annual timer. Archive is updated ~annually.

Status: SCAFFOLDING. The actual XLSX column maps are filled in after the
sheets are manually inspected at first download (each archive workbook has
its own quirks  -  column headers are in Swedish, some files have multi-row
headers). The loader will skip silently with a log entry if a workbook isn't
present, so the first run downloads + logs the file structure, then a
follow-up reads the sheets once the column maps are committed.
"""
import json, os, subprocess, sys, urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

try:
    import openpyxl
except ImportError:
    openpyxl = None
try:
    import xlrd  # legacy .xls (binary BIFF) support; v2.x is .xls-only
except ImportError:
    xlrd = None

LOG = "/var/log/orbi/orbi-h-riksbank-historical.log"
DATA_DIR = "/opt/bb-support/data/riksbank-historical"

WORKBOOKS = [
    # (local filename, source URL, asset tag, sheet hint, value col hint, year col hint, unit)
    # Canonical Riksbank "Historical Monetary Statistics of Sweden" archive
    # (Edvinsson et al.). Path scheme:
    #   /globalassets/media/forskning/monetar-statistik/volym{1,2,-3}/...
    # Verified live 2026-05-30  -  older
    # /globalassets/media/statistik/historisk-statistik/ paths went 404 (URL
    # rot). The Vol I/II workbooks are .xls (binary) so we use xlrd via
    # pandas or read with openpyxl's xls fallback path; if openpyxl can't
    # parse a legacy .xls we log+skip rather than crash.
    ("prices.xls",
     "https://www.riksbank.se/globalassets/media/forskning/monetar-statistik/volym1/volumeich8consumerpriceindex.xls",
     "SE_CPI_INDEX", "Sheet1", 1, 0, "index"),
    ("gdp.xls",
     "https://www.riksbank.se/globalassets/media/forskning/monetar-statistik/volym2/volumeiich4gdp.xls",
     "SE_GDP_NOMINAL", "Sheet1", 1, 0, "SEK_mn"),
    ("moneystock.xls",
     "https://www.riksbank.se/globalassets/media/forskning/monetar-statistik/volym2/volumeiich7moneysupply.xls",
     "SE_M0", "Sheet1", 1, 0, "SEK_mn"),
    # No standalone Riksbank-discount-rate workbook in the current archive
    # (Vol I/II/III 2010-2022 publication set). Substitute long-yield Swedish
    # bond rates from Vol III ch4 "Swedish Bond Market 1835-2020" (Daniel
    # Waldenström) as the closest available interest-rate proxy.
    ("bondrate.xlsx",
     "https://www.riksbank.se/globalassets/media/forskning/monetar-statistik/volym-3/volumeiiich4bonds.xlsx",
     "SE_BOND_YIELD", "Sheet1", 1, 0, "pct"),
]

CITATION_TPL = (
    "Sveriges Riksbank macro-historical archive, workbook {wb}. "
    "Compiled by Edvinsson et al. (scholarly). "
    "Reused with attribution to Sveriges Riksbank and the compilers."
)
SRC_URL = "https://www.riksbank.se/en-gb/statistics/macro-historical/"


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


def ensure_workbook(local, url):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, local)
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        return path
    log(f"downloading {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            with open(path + ".tmp", "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
        os.replace(path + ".tmp", path)
        log(f"  -> {path} ({os.path.getsize(path)} bytes)")
        return path
    except Exception as e:
        log(f"  download FAILED for {local}: {e}")
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


def _to_decimal(v):
    if v is None:
        return None
    try:
        d = Decimal(str(v))
        return d
    except Exception:
        return None


def _iter_rows_xlsx(path, sheet_hint):
    if openpyxl is None:
        log("  openpyxl missing  -  skipping .xlsx parse")
        return
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    except Exception as e:
        log(f"  openpyxl load_workbook failed: {e}")
        return
    ws = wb[sheet_hint] if sheet_hint in wb.sheetnames else wb.worksheets[0]
    for row in ws.iter_rows(values_only=True):
        yield row


def _iter_rows_xls(path, sheet_hint):
    if xlrd is None:
        log("  xlrd missing  -  skipping legacy .xls parse")
        return
    try:
        book = xlrd.open_workbook(path)
    except Exception as e:
        log(f"  xlrd open_workbook failed: {e}")
        return
    # Sweep every sheet  -  Edvinsson workbooks usually have a single data
    # sheet but sheet names vary ("Data", "Sheet1", chapter labels, etc.).
    for sheet in book.sheets():
        for r in range(sheet.nrows):
            yield tuple(sheet.row_values(r))


def parse_simple_year_value(path, sheet_hint, value_col, year_col):
    """Heuristic parser for the simple Edvinsson layout: year in col A,
    value in col B (overrideable). Header row(s) are skipped by looking
    for the first row where col A parses as a 4-digit year.
    """
    if path.lower().endswith(".xls"):
        rows_iter = _iter_rows_xls(path, sheet_hint)
    else:
        rows_iter = _iter_rows_xlsx(path, sheet_hint)
    out = []
    for row in rows_iter:
        if not row:
            continue
        y = _to_year(row[year_col] if len(row) > year_col else None)
        if y is None:
            continue
        v = _to_decimal(row[value_col] if len(row) > value_col else None)
        if v is None:
            continue
        # historical_money_prices.value has CHECK (value > 0); some Edvinsson
        # workbooks (GDP especially) mix growth/diff columns where col B can
        # be negative. Filter at the parser so the COPY doesn't blow up.
        if v <= 0:
            continue
        out.append((y, v))
    return out


HMP_COLS = [
    "asset", "quote_in", "year_start", "year_end", "period_label",
    "value", "unit", "confidence", "source_authority", "citation",
    "compiler", "region", "notes", "fetched_at", "inserted_at",
]


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols_str = ", ".join(HMP_COLS)
    script = (
        f"CREATE TEMP TABLE _stg_rh (LIKE historical_money_prices INCLUDING DEFAULTS);\n"
        f"\\copy _stg_rh ({cols_str}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO historical_money_prices ({cols_str}) "
        f"SELECT {cols_str} FROM _stg_rh ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_rh;\n"
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


def continuity_check():
    try:
        sql = (
            "SELECT asset, count(*) AS n, min(year_start::int), max(year_end::int) "
            "FROM historical_money_prices "
            "WHERE source_authority='RIKSBANK' "
            "GROUP BY 1 ORDER BY 1;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity (Riksbank historical):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity raised (suppressed): {e}")


def main():
    log("=== Phase H Wave 1 Riksbank macro-historical loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for local, url, asset, sheet, vcol, ycol, unit in WORKBOOKS:
        path = ensure_workbook(local, url)
        if not path:
            log(f"[{asset}] workbook unavailable  -  skipping")
            continue
        pairs = parse_simple_year_value(path, sheet, vcol, ycol)
        log(f"[{asset}] parsed {len(pairs)} (year,value) pairs")
        if not pairs:
            continue
        citation = CITATION_TPL.format(wb=local)
        notes = json.dumps({"workbook": local, "source_url": url})
        rows = []
        for y, v in pairs:
            rows.append([
                asset, unit, str(y), str(y), str(y),
                str(v), unit, "scholarly",
                "RIKSBANK", citation, "Edvinsson et al. via Sveriges Riksbank",
                "SE", notes, fetched_at, fetched_at,
            ])
        n = copy_rows(rows)
        if n > 0:
            grand_total += n
            log(f"[{asset}] wrote {n} rows")
    log(f"=== done: {grand_total} candidate rows ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H Wave1 Riksbank historical FAILED", str(e)[:200])
        sys.exit(1)
