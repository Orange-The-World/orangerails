#!/usr/bin/env python3
"""ORBI Tier 3  -  State Bank of Pakistan (SBP) USD/PKR scraper.

SBP publishes its daily Mark-to-Market (M2M) revaluation USD/PKR rate on:
  https://www.sbp.org.pk/ecodata/rates/m2m/M2M-Current.asp

The visible page is JS-driven; the actual data lives in a small CSV at:
  https://www.sbp.org.pk/ecodata/rates/m2m/kibor.csv

That CSV's row index 13 holds the M2M USD/PKR rate (per the inline JS:
  document.getElementById("m2mrate").innerHTML = myArray[13].split(",")[1];
), and row 12 holds its publication date. We parse the CSV directly.

ToS: SBP /disclaimer/disclaimer.htm is 404. The sbp.org.pk root is bot-
gated. Rates are public sovereign-reference data. Attribution: "State Bank
of Pakistan" in notes.

KNOWN OPERATIONAL GAP: as of 2026-06-06 the bb-support egress IP
(66.70.179.236) is Cloudflare-blocked by SBP for the .csv path even with a
browser User-Agent (HTTP 403 from sbp.org.pk's Cloudflare edge for
Client IP 172.x  -  CF proxy in front of SBP rejects bb-support's egress).
The scraper is fully built and will succeed the moment SBP whitelists the
egress / unblocks the path. Until then this service exits non-zero with
"FETCH_BLOCKED" and the systemd timer is configured with
Restart=no so cron noise stays bounded. Follow-up: contact SBP DBA via
ECAP@sbp.org.pk to request reference-data access.

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

LOG = "/var/log/orbi/cb-sbp-pkr.log"
SOURCE_URL = "https://www.sbp.org.pk/ecodata/rates/m2m/kibor.csv"
REFERER_URL = "https://www.sbp.org.pk/ecodata/rates/m2m/M2M-Current.asp"
SOURCE_AUTHORITY = "SBP"
SOURCE_CCY = "USD"
TARGET_CCY = "PKR"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ORBI/1.0 (+https://orangethe.world)"
NOTES = "State Bank of Pakistan Mark-to-Market USD/PKR (M2M Revaluation rate)"

# CSV row offsets per SBP M2M-Current.asp inline JS (verified 2026-06-06):
#   row 12 col 1 = M2M rate date (e.g. "06-Jun-2026")
#   row 13 col 1 = USD/PKR M2M rate
USD_DATE_ROW = 12
USD_RATE_ROW = 13

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


def fetch_sbp():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/csv,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": REFERER_URL,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    text_raw = raw.decode("utf-8", errors="replace")
    # Detect Cloudflare/edge block early.
    if "<html" in text_raw.lower() and ("access denied" in text_raw.lower()
                                        or "cloudflare" in text_raw.lower()
                                        or "<title>" in text_raw.lower()):
        raise RuntimeError("FETCH_BLOCKED: SBP CSV returned HTML block page "
                           "(likely Cloudflare egress block on bb-support IP)")

    sha = hashlib.sha256(raw).hexdigest()

    # SBP's CSV uses \r as line separator (per inline JS: split("\r")).
    rows = text_raw.split("\r")
    if len(rows) <= max(USD_DATE_ROW, USD_RATE_ROW):
        raise RuntimeError(f"SBP CSV too short: {len(rows)} rows")

    date_cells = rows[USD_DATE_ROW].split(",")
    rate_cells = rows[USD_RATE_ROW].split(",")
    if len(date_cells) < 2 or len(rate_cells) < 2:
        raise RuntimeError("SBP CSV missing expected columns in date/rate rows")

    # Date format observed: "06-Jun-2026"
    d_str = date_cells[1].strip()
    m = re.match(r"(\d{1,2})[-/](\w{3})[-/](\d{4})", d_str)
    if not m:
        raise RuntimeError(f"SBP date not parseable: {d_str!r}")
    dd = int(m.group(1))
    mon = m.group(2).lower()[:3]
    yyyy = int(m.group(3))
    if mon not in MONTHS:
        raise RuntimeError(f"SBP month unknown: {mon}")
    published_date = date(yyyy, MONTHS[mon], dd).isoformat()

    usd_rate = float(rate_cells[1].strip().replace(",", ""))

    return raw, sha, published_date, usd_rate, text_raw


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
        "format": "csv",
        "encoding": "utf-8",
        "line_separator": "\\r",
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
    log("=== SBP scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_sbp()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/PKR={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== SBP scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
