#!/usr/bin/env python3
"""ORBI Phase H  -  NBU USD/UAH historical backfill walker.

Uses NBU's date-range endpoint:
  https://bank.gov.ua/NBU_Exchange/exchange_site?start=YYYYMMDD&end=YYYYMMDD&valcode=usd&json
Walks backward in month-sized chunks from yesterday to 1996-09-02 (the UAH
redenomination date  -  pre-Sept-1996 records are in karbovanets, not hryvnias;
those rows are skipped to keep the live USD/UAH series semantically clean).

Idempotent; polite (1 req/sec); identifying UA.
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

LOG = "/var/log/orbi/cb-nbu-uah-historical.log"
SOURCE_URL_TMPL = (
    "https://bank.gov.ua/NBU_Exchange/exchange_site"
    "?start={d1}&end={d2}&valcode=usd&sort=exchangedate&order=desc&json"
)
SOURCE_AUTHORITY = "NBU"
SOURCE_CCY = "USD"
TARGET_CCY = "UAH"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
EARLIEST_DATE = date(1996, 9, 2)  # UAH (post-redenomination)
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
RUN_ID = f"nbu-uah-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


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


def fetch_range(d_from, d_to):
    url = SOURCE_URL_TMPL.format(
        d1=d_from.strftime("%Y%m%d"), d2=d_to.strftime("%Y%m%d"))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw.decode("utf-8"))
    out = []
    for rec in data:
        ex = rec.get("exchangedate")  # "DD.MM.YYYY"
        # NBU API normalization: prefer rate_per_unit (already per-1-USD).
        # rate is per-`units` (units=100 for pre-2019-12-28 records); only
        # divide by units when falling back to rate.
        rpu = rec.get("rate_per_unit")
        raw_rate = rec.get("rate")
        units = rec.get("units") or 1
        if not ex or (rpu is None and raw_rate is None):
            continue
        dd, mm, yy = ex.split(".")
        pub = date(int(yy), int(mm), int(dd))
        if pub < EARLIEST_DATE:
            continue
        try:
            if rpu is not None:
                rate = float(rpu)  # already per-1-USD
            else:
                rate = float(raw_rate) / float(units or 1)
        except Exception:
            continue
        if rate <= 0:
            continue
        # Sanity: post-redenomination USD/UAH should never be < 1.0
        if rate < 1.0 and pub > date(1996, 9, 2):
            log(f"  WARN scale-anomaly {pub} rate={rate} units={units}  -  skipped")
            continue
        out.append((pub.isoformat(), rate, sha, url))
    return out, raw.decode("utf-8")


def write_extraction(pub_date, rate, sha, source_url, raw_text):
    raw_json = json.dumps({
        "format": "json",
        "raw_text": raw_text[:200000],
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
    log("Per-year row counts (full series):")
    seen = []
    if res:
        for line in res.splitlines():
            parts = line.split("|")
            if len(parts) == 2:
                y, n = int(parts[0]), int(parts[1])
                seen.append(y)
                log(f"  {y}: {n}")
                if n < 10:
                    log(f"  *** LOW year {y}: {n}")
    if seen:
        zero = sorted(set(range(min(seen), max(seen) + 1)) - set(seen))
        if zero:
            log(f"  *** ZERO-ROW YEARS: {zero}")
        else:
            log("  continuity OK")


def month_starts_descending(end):
    # yields (chunk_start, chunk_end) walking backward
    cur_end = end
    while cur_end >= EARLIEST_DATE:
        cur_start = cur_end.replace(day=1)
        if cur_start < EARLIEST_DATE:
            cur_start = EARLIEST_DATE
        yield cur_start, cur_end
        cur_end = cur_start - timedelta(days=1)


def main():
    log(f"=== NBU historical backfill start run_id={RUN_ID} ===")
    end = date.today() - timedelta(days=1)
    total = 0
    consecutive_empty = 0
    for d1, d2 in month_starts_descending(end):
        try:
            recs, raw_text = fetch_range(d1, d2)
        except Exception as e:
            log(f"  {d1}..{d2} fetch FAIL: {e}")
            time.sleep(RATE_LIMIT_S)
            continue
        log(f"  {d1}..{d2}: {len(recs)} records")
        if not recs:
            consecutive_empty += 1
            if consecutive_empty >= 3 and d1 <= EARLIEST_DATE + timedelta(days=90):
                log(f"  stopping at {d1}  -  {consecutive_empty} consecutive empty months")
                break
            time.sleep(RATE_LIMIT_S)
            continue
        consecutive_empty = 0
        for pub, rate, sha, url in recs:
            write_extraction(pub, rate, sha, url, raw_text)
            upsert_exchange_rate(pub, rate)
            total += 1
        time.sleep(RATE_LIMIT_S)
    log(f"=== NBU historical backfill done  -  {total} writes ===")
    continuity_check()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
