#!/usr/bin/env python3
"""ORBI Phase H  -  BAM USD/MAD historical backfill walker.

BAM's bkam.ma CSV endpoint exposes only 2 business days (current + previous).
There is no public archive endpoint for daily reference rates that we can
discover at the time of writing. This walker:

  1. Fetches the live CSV and writes BOTH dates it exposes as
     historical-backfill rows (the previous business day is the only
     extra information not already captured by the live forward scraper).
  2. Logs an explicit "depth: 2 business days only" note.
  3. Continuity check still reports per-year for whatever rows exist.

If/when BAM publishes a deeper archive (XLS/CSV historical bundle), extend
this walker rather than the live one.
"""
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-bam-mad-historical.log"
SOURCE_URL = (
    "https://www.bkam.ma/export/blockcsv/4550/"
    "5312b6def4ad0a94c5a992522868ac0a/"
    "cc51b5ce6878a3dc655dae26c47fddf8"
    "?block=cc51b5ce6878a3dc655dae26c47fddf8"
)
SOURCE_AUTHORITY = "BAM"
SOURCE_CCY = "USD"
TARGET_CCY = "MAD"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
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
RUN_ID = f"bam-mad-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


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


def fetch_csv():
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))

    dates_iso = []
    for row in rows:
        if len(row) >= 2 and row[0] == "":
            for cell in row[1:]:
                m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", cell.strip())
                if m:
                    dd, mm, yy = m.groups()
                    dates_iso.append(date(int(yy), int(mm), int(dd)).isoformat())
            if dates_iso:
                break
    rates = []
    for row in rows:
        if not row:
            continue
        label = row[0].strip().strip('"').upper()
        if "DOLLAR U.S.A" in label or "DOLLAR USA" in label:
            for cell in row[1:]:
                try:
                    rates.append(float(cell.strip().replace(",", ".")))
                except ValueError:
                    pass
            break
    return sha, text, dates_iso, rates


def write_extraction(pub_date, rate, sha, raw_text):
    raw_json = json.dumps({
        "format": "csv",
        "raw_text": raw_text[:20000],
        "historical_run_id": RUN_ID,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "published_date": pub_date,
        "depth_note": "BAM CSV exposes 2 business days only",
    }).replace("'", "''")
    notes = f"historical-backfill run_id={RUN_ID}"
    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload, notes) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{pub_date}', {rate}, '{SOURCE_URL}', '{sha}', '{raw_json}'::jsonb, "
        f"'{notes}') ON CONFLICT DO NOTHING;"
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
        "SELECT EXTRACT(YEAR FROM bucket_ts)::int, COUNT(*) "
        f"FROM exchange_rates WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        "GROUP BY 1 ORDER BY 1;"
    )
    res = q(sql)
    log("Per-year row counts:")
    if res:
        for line in res.splitlines():
            log(f"  {line}")


def main():
    log(f"=== BAM historical backfill start run_id={RUN_ID} ===")
    log("NOTE: BAM CSV depth = 2 business days only. No deeper archive.")
    sha, raw_text, dates, rates = fetch_csv()
    log(f"  dates: {dates}  rates: {rates}")
    n = min(len(dates), len(rates))
    total = 0
    for i in range(n):
        pub, rate = dates[i], rates[i]
        if rate <= 0:
            continue
        write_extraction(pub, rate, sha, raw_text)
        upsert_exchange_rate(pub, rate)
        total += 1
    log(f"=== BAM historical backfill done  -  {total} writes ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
