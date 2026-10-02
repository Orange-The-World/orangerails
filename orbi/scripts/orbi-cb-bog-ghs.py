#!/usr/bin/env python3
"""ORBI Tier 3  -  Bank of Ghana (BOG) USD/GHS scraper.

BOG publishes daily interbank FX rates via a wpDataTables widget on:
  https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/

The page pre-renders the latest 25 rows of the table as static <tr> elements
(`<tr id="table_31_row_0">`). We parse those rows directly: column 0 = date
"DD MMM YYYY", column 1 = currency, column 2 = pair, 3/4/5 = buy/sell/mid.

For USD/GHS we read the USDGHS row's mid column.

ToS: BOG /terms-of-use returns 404. Rates are public sovereign-reference
data. We attribute "Bank of Ghana" in notes, identify via User-Agent.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import hashlib
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-bog-ghs.log"
SOURCE_URL = "https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/"
SOURCE_AUTHORITY = "BOG"
SOURCE_CCY = "USD"
TARGET_CCY = "GHS"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ORBI/1.0 (+https://orangethe.world)"
NOTES = "Bank of Ghana daily interbank USD/GHS mid rate (BOG official)"

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


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


def q(sql, timeout=30, return_output=True):
    # Pass SQL on stdin to avoid argv length limits (raw_payload can be >100KB).
    r = subprocess.run(["psql", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True,
                       timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip() if return_output else ""


def fetch_bog():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.URLError as e:
        msg = str(e).upper()
        if "CERTIFICATE" in msg or "SSL" in msg:
            log("WARN: strict TLS failed; falling back to permissive context")
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                raw = resp.read()
        else:
            raise

    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")

    row_pat = re.compile(
        r"<tr[^>]*table_31_row_\d+[^>]*>\s*"
        r"<td[^>]*>\s*(\d{1,2}\s+\w+\s+\d{4})\s*</td>\s*"
        r"<td[^>]*>([^<]+)</td>\s*"
        r"<td[^>]*>([^<]+)</td>\s*"
        r"<td[^>]*>([0-9.,]+)</td>\s*"
        r"<td[^>]*>([0-9.,]+)</td>\s*"
        r"<td[^>]*>([0-9.,]+)</td>",
        re.IGNORECASE,
    )
    rows = row_pat.findall(text)
    if not rows:
        raise RuntimeError("BOG: no table rows parsed")

    usd_row = None
    for d_str, ccy, pair, buy, sell, mid in rows:
        if pair.strip().upper() == "USDGHS":
            usd_row = (d_str, buy, sell, mid)
            break
    if usd_row is None:
        raise RuntimeError("BOG USDGHS row not found in first 25 rows")

    d_str, buy, sell, mid = usd_row
    parts = d_str.split()
    dd = int(parts[0])
    mon = parts[1][:3].lower()
    yyyy = int(parts[2])
    if mon not in MONTHS:
        raise RuntimeError(f"BOG month not recognized: {parts[1]}")
    published_date = date(yyyy, MONTHS[mon], dd).isoformat()
    usd_rate = float(mid.replace(",", ""))

    return raw, sha, published_date, usd_rate, text


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
        "format": "html",
        "encoding": "utf-8",
        "raw_text": raw_text,
        "raw_byte_count": len(raw_bytes),
    }).replace("'", "''")
    notes_sql = NOTES.replace("'", "''")
    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload, notes) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{published_date_iso}', {usd_rate}, '{SOURCE_URL}', '{sha}', "
        f"'{raw_json}'::jsonb, '{notes_sql}') "
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
        f"VALUES ('USD', '{TARGET_CCY}', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== BOG scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_bog()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/GHS={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== BOG scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
