#!/usr/bin/env python3
"""ORBI Tier 3  -  National Bank of Ukraine (NBU) USD/UAH scraper.

NBU publishes daily reference rates via a clean JSON API.
Endpoint docs: https://bank.gov.ua/en/open-data/api-dev
"""
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-nbu-uah.log"
SOURCE_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json"
SOURCE_AUTHORITY = "NBU"
SOURCE_CCY = "USD"
TARGET_CCY = "UAH"
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
        "PGDATABASE": (p.path or "/").lstrip("/"),
    }


PG = _pg_env()


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


def q(sql, timeout=1200, return_output=True):
    # Pass SQL on stdin to avoid argv length limits (raw_payload can be large).
    r = subprocess.run(["psql", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True,
                       timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip() if return_output else ""


def fetch_nbu():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate)."""
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()

    data = json.loads(raw.decode("utf-8"))
    if not data:
        raise RuntimeError("NBU returned empty array")
    row = data[0]
    if row.get("cc") != "USD":
        raise RuntimeError(f"Expected cc=USD, got {row.get('cc')}")

    # NBU date is DD.MM.YYYY
    d, m, y = row["exchangedate"].split(".")
    published_date = date(int(y), int(m), int(d)).isoformat()
    usd_rate = float(row["rate"])

    return raw, sha, published_date, usd_rate


def previous_rate_for(published_date_iso):
    res = q(
        "SELECT rate FROM cb_rate_extractions "
        f"WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        f"AND published_date='{published_date_iso}' "
        "ORDER BY extracted_at DESC LIMIT 1"
    )
    return float(res) if res else None


def write_extraction(raw_bytes, sha, published_date_iso, usd_rate, raw_text):
    raw_json = json.dumps({
        "format": "json",
        "encoding": "utf-8",
        "raw_text": raw_text,
        "raw_byte_count": len(raw_bytes),
    }).replace("'", "''")

    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{published_date_iso}', {usd_rate}, '{SOURCE_URL}', '{sha}', "
        f"'{raw_json}'::jsonb) "
        "ON CONFLICT DO NOTHING RETURNING id;"
    )
    res = q(sql)
    if res:
        log(f"appended extraction id={res}")
        return True
    log("extraction was duplicate  -  no-op")
    return False


def upsert_exchange_rate(published_date_iso, usd_rate):
    bucket_ts = f"{published_date_iso} 00:00:00+00"
    sql = (
        "INSERT INTO exchange_rates "
        "(source_currency, target_currency, bucket_ts, granularity, product, "
        " rate, tier, composite, composite_via, provider_count, status, "
        " fetched_at, computed_at, provenance, source_authority) "
        f"VALUES ('USD', 'UAH', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== NBU scrape start ===")
    raw, sha, published_date, usd_rate = fetch_nbu()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/UAH={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    raw_text = raw.decode("utf-8")
    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== NBU scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
