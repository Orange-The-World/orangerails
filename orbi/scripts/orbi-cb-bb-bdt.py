#!/usr/bin/env python3
"""ORBI Tier 3  -  Bangladesh Bank (BB) USD/BDT scraper.

Bangladesh Bank publishes daily USD/BDT bid-ask interbank rates on:
  https://www.bb.org.bd/en/index.php/econdata/exchangerate

The page renders a small HTML table whose first row is:
  <tr><td>USD</td><td>{bid}</td><td>{ask}</td><td>{mid}</td></tr>

We capture the mid as the BB authoritative rate. The page footer explicitly
states the rates represent "the highest and lowest interbank exchange rates
at Dhaka close on the previous business day"  -  so published_date is the
previous business day, communicated by BB in its rate disclosure language.

Because BB does not stamp a machine-readable date on the page, we extract
the page's "as on" date string and fall back to the visible Bengali/English
date label in the wrapping div. If neither is present we default to UTC
"today minus 1 business day" with a warning logged.

ToS: BB does not publish an explicit terms-of-use for econdata. The rates
are public sovereign-reference data, attributed to "Bangladesh Bank" in
the notes column. robots.txt is gated behind a JS bot-challenge.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

LOG = "/var/log/orbi/cb-bb-bdt.log"
SOURCE_URL = "https://www.bb.org.bd/en/index.php/econdata/exchangerate"
SOURCE_AUTHORITY = "BB"
SOURCE_CCY = "USD"
TARGET_CCY = "BDT"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
NOTES = "Bangladesh Bank interbank USD/BDT mid rate (Dhaka close, prior business day)"


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


def _prev_business_day(d):
    # BB rates represent prior business day. Naive: skip Fri/Sat (BD weekend).
    one = d - timedelta(days=1)
    # Bangladesh weekend = Friday(4)+Saturday(5). Roll back to Thursday(3).
    while one.weekday() in (4, 5):
        one -= timedelta(days=1)
    return one


def fetch_bb():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")

    # Locate the USD row inside the A. USD/BDT table.
    # Row pattern: <tr><td>USD</td><td>BID</td><td>ASK</td><td>MID</td></tr>
    # Defensively grab any <tr>…<td>USD</td>…</tr> first.
    m = re.search(
        r"<tr[^>]*>\s*<td[^>]*>\s*USD\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>",
        text, re.IGNORECASE,
    )
    if not m:
        # Some BB layouts have only 2 columns (single quote).
        m2 = re.search(
            r"<tr[^>]*>\s*<td[^>]*>\s*USD\s*</td>\s*<td[^>]*>\s*([0-9.,]+)\s*</td>",
            text, re.IGNORECASE,
        )
        if not m2:
            raise RuntimeError("BB USD row not found in HTML")
        usd_rate = float(m2.group(1).replace(",", ""))
    else:
        # Mid is third numeric col when present; else avg(bid, ask).
        bid = float(m.group(1).replace(",", ""))
        ask = float(m.group(2).replace(",", ""))
        mid = float(m.group(3).replace(",", ""))
        usd_rate = mid if mid > 0 else (bid + ask) / 2.0

    # Try to lift an "as on DD MMM YYYY" or similar date from the page.
    published_date = None
    date_patterns = [
        # "as on 04 June 2026" / "as on 04-06-2026"
        r"as on\s+(\d{1,2})[\s\-/](\w+)[\s\-/](\d{4})",
        # "Date: 04 June 2026"
        r"Date[:\s]+(\d{1,2})\s+(\w+)\s+(\d{4})",
        # "04 June, 2026"
        r"(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)[,\s]+(\d{4})",
    ]
    months = {m.lower()[:3]: i for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June",
         "July", "August", "September", "October", "November", "December"], 1)}
    for pat in date_patterns:
        mm = re.search(pat, text, re.IGNORECASE)
        if mm:
            try:
                dd = int(mm.group(1))
                mon_raw = mm.group(2).lower()[:3]
                yyyy = int(mm.group(3))
                if mon_raw in months:
                    published_date = date(yyyy, months[mon_raw], dd).isoformat()
                    break
                # Maybe digits.
                if mon_raw.isdigit():
                    published_date = date(yyyy, int(mon_raw), dd).isoformat()
                    break
            except (ValueError, KeyError):
                continue

    if not published_date:
        # Fall back to prev business day (UTC reference).
        published_date = _prev_business_day(datetime.now(timezone.utc).date()).isoformat()
        log(f"WARN: no on-page date found, defaulting to prior business day {published_date}")

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
    log("=== BB scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_bb()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/BDT={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== BB scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
