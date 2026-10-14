#!/usr/bin/env python3
"""ORBI Phase H  -  Bank of Algeria USD/DZD historical backfill walker.

Bank of Algeria publishes a multi-sheet XLSX with daily rates back to
2000-01-03 at https://www.bank-of-algeria.dz/donnees-historiques/.
The current file is named like:
  /stoodroa/{YYYY}/{MM}/Cotation-DZD-{start}-{end}-journalier.xlsx

Network fetches use curl as a subprocess because BoA's TLS chain is
incomplete (intermediate not served) and curl with the system CA bundle
recovers gracefully (-k accepts the trust gap; we still hash the bytes so
tamper-evidence is preserved end-to-end via raw_payload_sha256).
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import uuid
from datetime import datetime, timezone, date
from pathlib import Path

try:
    import openpyxl
except ImportError:
    openpyxl = None

LOG = "/var/log/orbi/cb-bank-of-algeria-dzd-historical.log"
INDEX_URL = "https://www.bank-of-algeria.dz/donnees-historiques/"
SOURCE_AUTHORITY = "BANK_OF_ALGERIA"
SOURCE_CCY = "USD"
TARGET_CCY = "DZD"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
DATA_DIR = "/opt/bb-support/data/boa-historical"


def _load_local_dsn():
    for line in open("/opt/bb-support/.env"):
        if line.startswith("ORBI_LOCAL_DB_URL="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v


def _pg_env():
    p = urllib.parse.urlparse(_load_local_dsn())
    return {**os.environ,
            "PGHOST": p.hostname, "PGPORT": str(p.port or 5432),
            "PGUSER": urllib.parse.unquote(p.username or ""),
            "PGPASSWORD": urllib.parse.unquote(p.password or ""),
            "PGDATABASE": (p.path or "/").lstrip("/")}


PG = _pg_env()
RUN_ID = f"boa-dzd-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    print(line)
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def q(sql, timeout=60, return_output=True):
    r = subprocess.run(["psql", "-At", "-F", "|", "-c", sql],
                       capture_output=True, text=True, timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:300]}")
        return None
    return r.stdout.strip() if return_output else ""


def curl_get(url, out_path=None, timeout=180):
    """Fetch via curl (handles BoA's incomplete cert chain). Returns bytes
    if out_path is None, else writes to file and returns the path."""
    args = ["curl", "-sSL", "-A", USER_AGENT, "-k", "--max-time", str(timeout)]
    if out_path:
        args += ["-o", out_path, url]
        r = subprocess.run(args, capture_output=True, timeout=timeout + 30)
        if r.returncode != 0:
            raise RuntimeError(f"curl failed: {r.stderr[:200]!r}")
        return out_path
    args.append(url)
    r = subprocess.run(args, capture_output=True, timeout=timeout + 30)
    if r.returncode != 0:
        raise RuntimeError(f"curl failed: {r.stderr[:200]!r}")
    return r.stdout


def discover_xlsx_url():
    html = curl_get(INDEX_URL, timeout=60).decode("utf-8", errors="replace")
    m = re.search(
        r'href="(https://www\.bank-of-algeria\.dz/[^"]*Cotation-DZD[^"]*\.xlsx)"',
        html)
    if not m:
        raise RuntimeError("Cotation-DZD XLSX link not found")
    return m.group(1)


def parse_usd_sheet(xlsx_path):
    if openpyxl is None:
        raise RuntimeError("openpyxl missing")
    wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    sheet_name = None
    for s in wb.sheetnames:
        if s.strip().upper().startswith("USD"):
            sheet_name = s
            break
    if not sheet_name:
        raise RuntimeError(f"USD sheet not found; sheets={wb.sheetnames}")
    ws = wb[sheet_name]
    out = []
    for row in ws.iter_rows(values_only=True):
        if not row or len(row) < 2:
            continue
        d_cell, v_cell = row[0], row[1]
        if not isinstance(d_cell, datetime):
            continue
        try:
            rate = float(v_cell)
        except (TypeError, ValueError):
            continue
        if rate <= 0:
            continue
        out.append((d_cell.date().isoformat(), rate))
    return out


def write_batches(rows, sha, source_url):
    if not rows:
        return 0, 0
    extracted_at = datetime.now(timezone.utc).isoformat()
    fetched = extracted_at
    notes = f"historical-backfill run_id={RUN_ID}"
    CHUNK = 200
    n_ext = 0
    n_rates = 0
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        ext_values = []
        rate_values = []
        for pub, rate in chunk:
            raw_json = json.dumps({
                "format": "xlsx",
                "historical_run_id": RUN_ID,
                "extracted_at": extracted_at,
                "published_date": pub,
                "source": "Cotation-DZD daily workbook, USD-DZD sheet",
            }).replace("'", "''")
            ext_values.append(
                f"('{SOURCE_AUTHORITY}','{SOURCE_CCY}','{TARGET_CCY}',"
                f"'{pub}',{rate},'{source_url}','{sha}',"
                f"'{raw_json}'::jsonb,'{notes}')"
            )
            rate_values.append(
                f"('{SOURCE_CCY}','{TARGET_CCY}','{pub} 00:00:00+00','1d',"
                f"'ORBI-D-authority',{rate},'B-single',false,NULL,1,"
                f"'CONFIRMED','{fetched}','{fetched}','historical-backfill',"
                f"'{SOURCE_AUTHORITY}')"
            )
        sql1 = (
            "INSERT INTO cb_rate_extractions (source_authority, "
            "source_currency, target_currency, published_date, rate, "
            "source_url, raw_payload_sha256, raw_payload, notes) VALUES "
            + ",".join(ext_values) + " ON CONFLICT DO NOTHING;"
        )
        if q(sql1, timeout=120, return_output=False) is not None:
            n_ext += len(chunk)
        sql2 = (
            "INSERT INTO exchange_rates (source_currency, target_currency, "
            "bucket_ts, granularity, product, rate, tier, composite, "
            "composite_via, provider_count, status, fetched_at, computed_at, "
            "provenance, source_authority) VALUES " + ",".join(rate_values)
            + " ON CONFLICT (source_currency, target_currency, bucket_ts, "
            "source_authority, granularity, product) DO NOTHING;"
        )
        if q(sql2, timeout=120, return_output=False) is not None:
            n_rates += len(chunk)
    return n_ext, n_rates


def continuity_check():
    sql = (
        "SELECT EXTRACT(YEAR FROM bucket_ts)::int, COUNT(*) "
        f"FROM exchange_rates WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        "GROUP BY 1 ORDER BY 1;"
    )
    res = q(sql)
    log("Per-year row counts:")
    seen = []
    if res:
        for line in res.splitlines():
            p = line.split("|")
            if len(p) == 2:
                y, n = int(p[0]), int(p[1])
                seen.append(y); log(f"  {y}: {n}")
                if n < 50: log(f"  *** LOW year {y}: {n}")
    if seen:
        zero = sorted(set(range(min(seen), max(seen)+1)) - set(seen))
        if zero: log(f"  *** ZERO-ROW YEARS: {zero}")
        else: log("  continuity OK")


def main():
    log(f"=== Bank of Algeria historical backfill start run_id={RUN_ID} ===")
    url = discover_xlsx_url()
    log(f"  XLSX URL: {url}")
    os.makedirs(DATA_DIR, exist_ok=True)
    dest = os.path.join(DATA_DIR, os.path.basename(url))
    curl_get(url, out_path=dest, timeout=180)
    with open(dest, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    log(f"  downloaded {len(raw)} bytes  sha256={sha[:16]}…")
    rows = parse_usd_sheet(dest)
    log(f"  parsed {len(rows)} USD/DZD rows")
    n_ext, n_rates = write_batches(rows, sha, url)
    log(f"  cb_rate_extractions writes: {n_ext}")
    log(f"  exchange_rates upserts: {n_rates}")
    log(f"=== Bank of Algeria historical backfill done ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
