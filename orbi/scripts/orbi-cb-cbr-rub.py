#!/usr/bin/env python3
"""ORBI Tier 3  -  Central Bank of Russia (CBR) USD/RUB scraper.

Template for all 12 Tier 3 CB scrapers. Every run:
  1. Fetches the latest XML rates from CBR's official endpoint.
  2. Computes SHA-256 of the raw response for tamper-evidence.
  3. Parses USD/RUB out of the XML.
  4. Appends a row to cb_rate_extractions (always  -  even if unchanged).
  5. Detects + alerts on retroactive revisions (CBR has restated history).
  6. Upserts USD/RUB into exchange_rates so the live composite picks it up.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
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
from xml.etree import ElementTree as ET

LOG = "/var/log/orbi/cb-cbr-rub.log"
SOURCE_URL = "https://www.cbr.ru/scripts/XML_daily.asp"
SOURCE_AUTHORITY = "CBR"
SOURCE_CCY = "USD"
TARGET_CCY = "RUB"
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


def fetch_cbr():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate)."""
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()

    # CBR XML is windows-1251 encoded.
    text = raw.decode("windows-1251")
    root = ET.fromstring(text)

    pub_date_attr = root.attrib.get("Date")
    if not pub_date_attr:
        raise RuntimeError("CBR XML missing Date attribute")
    # DD.MM.YYYY -> YYYY-MM-DD
    d, m, y = pub_date_attr.split(".")
    published_date = date(int(y), int(m), int(d)).isoformat()

    usd_rate = None
    for v in root.findall("Valute"):
        if v.findtext("CharCode") == "USD":
            # Value is per-Nominal; VunitRate is per-unit (already normalized).
            val = v.findtext("VunitRate") or v.findtext("Value")
            if val is None:
                raise RuntimeError("USD Valute missing VunitRate/Value")
            usd_rate = float(val.replace(",", "."))
            nominal = int(v.findtext("Nominal") or "1")
            if not v.findtext("VunitRate"):
                # Older XML  -  normalize manually.
                usd_rate = usd_rate / nominal
            break
    if usd_rate is None:
        raise RuntimeError("USD CharCode not found in CBR XML")

    return raw, sha, published_date, usd_rate


def previous_rate_for(published_date_iso):
    """Latest prior extraction for the same published_date, if any."""
    res = q(
        "SELECT rate, extracted_at FROM cb_rate_extractions "
        f"WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        f"AND published_date='{published_date_iso}' "
        "ORDER BY extracted_at DESC LIMIT 1"
    )
    if not res:
        return None
    parts = res.split("|")
    return float(parts[0]) if len(parts) == 2 else None


def write_extraction(raw_bytes, sha, published_date_iso, usd_rate, raw_text):
    """Append to cb_rate_extractions. Idempotent via unique constraint on
    (authority, src, tgt, published_date, extracted_at)."""
    raw_json = json.dumps({
        "format": "xml",
        "encoding": "windows-1251",
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
    log("extraction was duplicate (same minute, same payload)  -  no-op")
    return False


def upsert_exchange_rate(published_date_iso, usd_rate):
    """Push USD/RUB into exchange_rates so downstream composite picks it up.
    granularity=1d, product=ORBI-D-authority."""
    bucket_ts = f"{published_date_iso} 00:00:00+00"
    sql = (
        "INSERT INTO exchange_rates "
        "(source_currency, target_currency, bucket_ts, granularity, product, "
        " rate, tier, composite, composite_via, provider_count, status, "
        " fetched_at, computed_at, provenance, source_authority) "
        f"VALUES ('USD', 'RUB', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', 'CBR') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== CBR scrape start ===")
    raw, sha, published_date, usd_rate = fetch_cbr()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/RUB={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f} delta={usd_rate - prev:+.4f}")
        # TODO: wire Signal/wiki alert per founder decision (Both channels).

    raw_text = raw.decode("windows-1251")
    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== CBR scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
