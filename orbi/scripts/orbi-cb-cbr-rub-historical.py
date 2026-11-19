#!/usr/bin/env python3
"""ORBI Phase H  -  CBR USD/RUB historical backfill walker.

Walks backward year-by-year via CBR's XML_dynamic.asp date-range endpoint
(VAL_NM_RQ=R01235 = USD), starting from yesterday and stopping when an
entire calendar year returns zero records (CBR's earliest USD record is
1992-07-01).

Idempotent via ON CONFLICT DO NOTHING on the unique key.
Polite: 1 req/sec, identifying User-Agent.

provenance='historical-backfill' (CHECK-constrained value; never improvise).
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone, date
from pathlib import Path
from xml.etree import ElementTree as ET

LOG = "/var/log/orbi/cb-cbr-rub-historical.log"
SOURCE_URL_TMPL = (
    "https://www.cbr.ru/scripts/XML_dynamic.asp"
    "?date_req1={d1}&date_req2={d2}&VAL_NM_RQ=R01235"
)
SOURCE_AUTHORITY = "CBR"
SOURCE_CCY = "USD"
TARGET_CCY = "RUB"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
EARLIEST_YEAR = 1992
RATE_LIMIT_S = 1.0


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
RUN_ID = f"cbr-rub-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


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


def fetch_year(year):
    """Returns list of (published_date_iso, usd_rate, raw_xml_text, sha)."""
    d1 = f"01/01/{year}"
    d2 = f"31/12/{year}"
    url = SOURCE_URL_TMPL.format(d1=d1, d2=d2)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("windows-1251")
    root = ET.fromstring(text)
    out = []
    for rec in root.findall("Record"):
        d_str = rec.attrib.get("Date")
        if not d_str:
            continue
        dd, mm, yy = d_str.split(".")
        pub = date(int(yy), int(mm), int(dd)).isoformat()
        val_txt = rec.findtext("VunitRate") or rec.findtext("Value")
        if not val_txt:
            continue
        rate = float(val_txt.replace(",", "."))
        if not rec.findtext("VunitRate"):
            nom = int(rec.findtext("Nominal") or "1")
            if nom != 1:
                rate = rate / nom
        if rate <= 0:
            continue
        out.append((pub, rate, sha, url))
    return out, text


def write_extraction(pub_date, rate, sha, source_url, raw_text):
    raw_json = json.dumps({
        "format": "xml",
        "encoding": "windows-1251",
        "raw_text": raw_text[:200000],  # cap per-record copy
        "historical_run_id": RUN_ID,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "published_date": pub_date,
    }).replace("'", "''")
    notes = f"historical-backfill run_id={RUN_ID}"
    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload, notes) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{pub_date}', {rate}, '{source_url}', '{sha}', '{raw_json}'::jsonb, "
        f"'{notes}') "
        "ON CONFLICT DO NOTHING;"
    )
    return q(sql, return_output=False) is not None


def upsert_exchange_rate(pub_date, rate):
    bucket_ts = f"{pub_date} 00:00:00+00"
    fetched = datetime.now(timezone.utc).isoformat()
    sql = (
        "INSERT INTO exchange_rates "
        "(source_currency, target_currency, bucket_ts, granularity, product, "
        " rate, tier, composite, composite_via, provider_count, status, "
        " fetched_at, computed_at, provenance, source_authority) "
        f"VALUES ('{SOURCE_CCY}', '{TARGET_CCY}', '{bucket_ts}', '1d', "
        f"'ORBI-D-authority', {rate}, 'B-single', false, NULL, 1, 'CONFIRMED', "
        f"'{fetched}', '{fetched}', 'historical-backfill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) DO NOTHING;"
    )
    return q(sql, return_output=False) is not None


def continuity_check():
    sql = (
        "SELECT EXTRACT(YEAR FROM bucket_ts)::int AS y, COUNT(*) "
        f"FROM exchange_rates WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        "GROUP BY 1 ORDER BY 1;"
    )
    res = q(sql)
    log("Per-year row counts (full series):")
    zero_years = []
    seen_years = []
    if res:
        for line in res.splitlines():
            parts = line.split("|")
            if len(parts) == 2:
                y, n = int(parts[0]), int(parts[1])
                seen_years.append(y)
                log(f"  {y}: {n}")
                if n < 10:
                    log(f"  *** LOW year {y}: {n} rows")
    if seen_years:
        full = set(range(min(seen_years), max(seen_years) + 1))
        zero_years = sorted(full - set(seen_years))
        if zero_years:
            log(f"  *** ZERO-ROW YEARS: {zero_years}")
        else:
            log("  continuity OK (no zero-row years in observed range)")


def main():
    log(f"=== CBR historical backfill start  run_id={RUN_ID} ===")
    today = date.today()
    end_year = today.year
    total = 0
    consecutive_empty = 0
    for year in range(end_year, EARLIEST_YEAR - 1, -1):
        try:
            records, raw_text = fetch_year(year)
        except Exception as e:
            log(f"  {year} fetch FAIL: {e}")
            time.sleep(RATE_LIMIT_S)
            continue
        log(f"  {year}: fetched {len(records)} records")
        if not records:
            consecutive_empty += 1
            if consecutive_empty >= 2 and year <= EARLIEST_YEAR + 1:
                log(f"  stopping  -  {consecutive_empty} consecutive empty years at/before {EARLIEST_YEAR}")
                break
            time.sleep(RATE_LIMIT_S)
            continue
        consecutive_empty = 0
        for pub, rate, sha, source_url in records:
            write_extraction(pub, rate, sha, source_url, raw_text)
            upsert_exchange_rate(pub, rate)
            total += 1
        time.sleep(RATE_LIMIT_S)
    log(f"=== CBR historical backfill done  -  {total} record-writes ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
