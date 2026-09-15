#!/usr/bin/env python3
"""ORBI Tier 3  -  Central Bank of Egypt (CBE) USD/EGP scraper.

CBE publishes its official daily exchange rates ("CBE Official Exchange rates
and prices are expressed in pounds") at:
  https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates

The page is Sitecore-rendered HTML containing a buy/sell table per currency.
A simple regex captures the "US Dollar" row's three numeric cells (buy / sell)
and the "Last Updated: DD MMM YYYY" stamp.

We use the mean of buy/sell as the CBE authoritative USD/EGP rate.

ToS: CBE does not expose a machine-readable terms-of-use document at common
URLs (legal-notice, terms-of-use); the homepage routes through a Volterra
WAF. The exchange-rate page is publicly served. We treat the rates as
sovereign-reference public data, attribute "Central Bank of Egypt" in notes,
identify ourselves via User-Agent, and request at <1 req/sec.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-cbe-egp.log"
SOURCE_URL = "https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates"
SOURCE_AUTHORITY = "CBE"
SOURCE_CCY = "USD"
TARGET_CCY = "EGP"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ORBI/1.0 (+https://orangethe.world)"
NOTES = "CBE Official USD/EGP rate (mean of buy/sell), published in EGP"

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


def fetch_cbe():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")

    # Match the US Dollar row + two adjacent numeric cells (buy, sell).
    m = re.search(
        r"US\s*Dollar\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>",
        text, re.IGNORECASE,
    )
    if not m:
        raise RuntimeError("CBE US Dollar row not found in HTML")
    buy = float(m.group(1).replace(",", ""))
    sell = float(m.group(2).replace(",", ""))
    usd_rate = (buy + sell) / 2.0

    # Last Updated: DD MMM YYYY
    md = re.search(r"Last Updated[:\s]+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", text)
    if md:
        dd = int(md.group(1))
        mon = md.group(2)[:3].lower()
        yyyy = int(md.group(3))
        if mon not in MONTHS:
            raise RuntimeError(f"CBE date month not recognized: {mon}")
        published_date = date(yyyy, MONTHS[mon], dd).isoformat()
    else:
        # Fall back to DD/MM/YYYY anywhere on page.
        md2 = re.search(r"(\d{2})/(\d{2})/(\d{4})", text)
        if md2:
            dd, mm, yyyy = int(md2.group(1)), int(md2.group(2)), int(md2.group(3))
            published_date = date(yyyy, mm, dd).isoformat()
        else:
            raise RuntimeError("CBE published date not found")

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
    log("=== CBE scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_cbe()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/EGP={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== CBE scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
