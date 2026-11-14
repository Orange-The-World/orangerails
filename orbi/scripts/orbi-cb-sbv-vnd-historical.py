#!/usr/bin/env python3
"""ORBI Phase H  -  SBV (via Vietcombank proxy) USD/VND historical backfill.

Vietcombank's public exchange-rates API exposes one date per request back to
~2020-02-01. SBV's direct portal serves only an SPA, so VCB remains the most
honest publicly accessible daily USD/VND record we can ingest.

Walks backward day-by-day from yesterday to 2020-02-01. Polite (1 req/sec),
identifying UA. Idempotent.
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
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

LOG = "/var/log/orbi/cb-sbv-vnd-historical.log"
SOURCE_URL_TMPL = "https://www.vietcombank.com.vn/api/exchangerates?date={d}"
SOURCE_AUTHORITY = "SBV"
SOURCE_CCY = "USD"
TARGET_CCY = "VND"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
EARLIEST_DATE = date(2020, 2, 1)
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
RUN_ID = f"sbv-vnd-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


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


def fetch_day(d):
    iso = d.isoformat()
    url = SOURCE_URL_TMPL.format(d=iso)
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")
    data = json.loads(text)
    server_date = (data.get("Date") or "")[:10]
    if server_date != iso:
        return None, sha, url, text
    rates = data.get("Data", []) or []
    usd = next((r for r in rates if r.get("currencyCode") == "USD"), None)
    if not usd:
        return None, sha, url, text
    transfer = usd.get("transfer") or usd.get("sell") or usd.get("cash")
    try:
        rate = float(str(transfer).replace(",", ""))
    except (TypeError, ValueError):
        return None, sha, url, text
    if rate <= 0:
        return None, sha, url, text
    return rate, sha, url, text


def write_extraction(pub_date, rate, sha, source_url, raw_text):
    raw_json = json.dumps({
        "format": "json",
        "raw_text": raw_text[:20000],
        "historical_run_id": RUN_ID,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "published_date": pub_date,
        "via": "Vietcombank proxy (SBV portal is SPA-only)",
    }).replace("'", "''")
    notes = f"historical-backfill run_id={RUN_ID}"
    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload, notes) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{pub_date}', {rate}, '{source_url}', '{sha}', '{raw_json}'::jsonb, "
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
    log(f"=== SBV/VCB historical backfill start run_id={RUN_ID} ===")
    cur = date.today() - timedelta(days=1)
    total = 0
    consecutive_empty = 0
    while cur >= EARLIEST_DATE:
        try:
            rate, sha, url, raw_text = fetch_day(cur)
        except Exception as e:
            log(f"  {cur} fetch FAIL: {e}")
            time.sleep(RATE_LIMIT_S)
            cur -= timedelta(days=1)
            continue
        if rate is None:
            consecutive_empty += 1
            if consecutive_empty >= 60:
                log(f"  stopping at {cur}  -  {consecutive_empty} consecutive empty days")
                break
        else:
            consecutive_empty = 0
            pub = cur.isoformat()
            write_extraction(pub, rate, sha, url, raw_text)
            upsert_exchange_rate(pub, rate)
            total += 1
            if total % 100 == 0:
                log(f"  ...progress: {cur} total={total}")
        cur -= timedelta(days=1)
        time.sleep(RATE_LIMIT_S)
    log(f"=== SBV/VCB historical backfill done  -  {total} writes ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
