#!/usr/bin/env python3
"""ORBI Phase H  -  CBN USD/NGN historical backfill walker.

CBN exposes a single bulk JSON endpoint covering all currencies, all dates,
back to ~2001-12-10:
  https://www.cbn.gov.ng/api/GetAllExchangeRates

One round-trip pulls ~60k rows. We filter to US DOLLAR, write the centralrate
(matches the live scraper's notion of the published rate).

Idempotent; one request total (no per-day looping needed).
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

LOG = "/var/log/orbi/cb-cbn-ngn-historical.log"
SOURCE_URL = "https://www.cbn.gov.ng/api/GetAllExchangeRates"
SOURCE_AUTHORITY = "CBN"
SOURCE_CCY = "USD"
TARGET_CCY = "NGN"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"


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
RUN_ID = f"cbn-ngn-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


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


def fetch_all():
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw.decode("utf-8"))
    return sha, data, raw


def write_extraction_batch(rows, sha):
    """rows = [(pub_date, rate)]. We collapse to one INSERT per row via a
    multi-row VALUES list to keep psql round-trips manageable."""
    if not rows:
        return 0
    written = 0
    extracted_at = datetime.now(timezone.utc).isoformat()
    # chunk to keep statements reasonable
    CHUNK = 200
    notes = f"historical-backfill run_id={RUN_ID}"
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        values = []
        for pub, rate in chunk:
            raw_json = json.dumps({
                "format": "json",
                "historical_run_id": RUN_ID,
                "extracted_at": extracted_at,
                "published_date": pub,
                "source": "GetAllExchangeRates centralrate column",
            }).replace("'", "''")
            values.append(
                f"('{SOURCE_AUTHORITY}','{SOURCE_CCY}','{TARGET_CCY}',"
                f"'{pub}',{rate},'{SOURCE_URL}','{sha}',"
                f"'{raw_json}'::jsonb,'{notes}')"
            )
        sql = (
            "INSERT INTO cb_rate_extractions "
            "(source_authority, source_currency, target_currency, "
            " published_date, rate, source_url, raw_payload_sha256, "
            " raw_payload, notes) VALUES "
            + ",".join(values)
            + " ON CONFLICT DO NOTHING;"
        )
        ok = q(sql, timeout=120, return_output=False) is not None
        if ok:
            written += len(chunk)
    return written


def upsert_rates_batch(rows):
    if not rows:
        return 0
    fetched = datetime.now(timezone.utc).isoformat()
    CHUNK = 200
    written = 0
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        values = []
        for pub, rate in chunk:
            values.append(
                f"('{SOURCE_CCY}','{TARGET_CCY}','{pub} 00:00:00+00','1d',"
                f"'ORBI-D-authority',{rate},'B-single',false,NULL,1,"
                f"'CONFIRMED','{fetched}','{fetched}','historical-backfill',"
                f"'{SOURCE_AUTHORITY}')"
            )
        sql = (
            "INSERT INTO exchange_rates "
            "(source_currency, target_currency, bucket_ts, granularity, "
            " product, rate, tier, composite, composite_via, provider_count, "
            " status, fetched_at, computed_at, provenance, source_authority) "
            "VALUES " + ",".join(values) +
            " ON CONFLICT (source_currency, target_currency, bucket_ts, "
            "source_authority, granularity, product) DO NOTHING;"
        )
        ok = q(sql, timeout=120, return_output=False) is not None
        if ok:
            written += len(chunk)
    return written


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
                if n < 10: log(f"  *** LOW year {y}: {n}")
    if seen:
        zero = sorted(set(range(min(seen), max(seen)+1)) - set(seen))
        if zero: log(f"  *** ZERO-ROW YEARS: {zero}")
        else: log("  continuity OK")


def main():
    log(f"=== CBN historical backfill start run_id={RUN_ID} ===")
    sha, data, raw = fetch_all()
    log(f"  fetched {len(data)} total rows from CBN")
    rows = []
    for rec in data:
        ccy = (rec.get("currency") or "").strip().upper()
        if ccy != "US DOLLAR":
            continue
        rd = rec.get("ratedate")  # "2026-06-05" ISO-like
        cr = rec.get("centralrate")
        if not rd or cr is None:
            continue
        try:
            # CBN returns ISO YYYY-MM-DD for ratedate in this endpoint.
            pub = date.fromisoformat(rd[:10]).isoformat()
            rate = float(cr)
        except Exception:
            continue
        if rate <= 0:
            continue
        rows.append((pub, rate))
    # dedupe by date (keep first)
    seen = set()
    dedup = []
    for pub, rate in rows:
        if pub in seen:
            continue
        seen.add(pub)
        dedup.append((pub, rate))
    log(f"  USD/NGN candidate writes: {len(dedup)}")
    n1 = write_extraction_batch(dedup, sha)
    log(f"  cb_rate_extractions writes: {n1}")
    n2 = upsert_rates_batch(dedup)
    log(f"  exchange_rates upserts: {n2}")
    log(f"=== CBN historical backfill done ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
