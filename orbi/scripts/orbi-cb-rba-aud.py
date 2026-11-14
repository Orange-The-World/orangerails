#!/usr/bin/env python3
"""ORBI Tier 3  -  Reserve Bank of Australia (RBA) USD/AUD daily loader.

Source: RBA statistical table F11 (exchange rates), daily CSV:
  https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv

The CSV quotes A$1 = X USD (AUD/USD). ORBI stores the USD/X convention,
so we invert: USD/AUD = 1 / (A$1=USD).

Published each RBA business day ~16:00 AEST (~06:00 UTC), skipping NSW
holidays. We take the LAST data row of the CSV (most recent business day).

ToS: RBA Copyright Notice Section 5 (Financial Data) permits reproduction,
publication and commercial use including derived products, with attribution
and no implied endorsement. Attribution: "Source: Reserve Bank of Australia".
Deep-dive: https://wiki.abascal.ca/doc/bcch-rba-tos-deep-dive-37TQRSDqrD

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import hashlib
import json
import os
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LOG = "/var/log/orbi/cb-rba-aud.log"
SOURCE_URL = "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv"
SOURCE_AUTHORITY = "RBA"
SOURCE_CCY = "USD"
TARGET_CCY = "AUD"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
NOTES = "Source: Reserve Bank of Australia. F11 daily AUD/USD inverted to USD/AUD."

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


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


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    print(line)
    # Best-effort file logging; OSError fallback per 2026-06-04 incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def q(sql, timeout=1200, return_output=True):
    # SQL via stdin (ARG_MAX safety); env-based PG credentials, never argv.
    r = subprocess.run(["psql", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True,
                       timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip() if return_output else ""


def parse_rba_date(raw):
    """F11 dates look like '10-Jun-2026'."""
    parts = raw.strip().split("-")
    if len(parts) != 3:
        return None
    dd, mon, yyyy = parts
    mon_n = MONTHS.get(mon.lower()[:3])
    if not mon_n:
        return None
    return f"{int(yyyy):04d}-{mon_n:02d}-{int(dd):02d}"


def fetch_rba():
    """Returns (raw_bytes, sha256, published_date_iso, usd_aud, aud_usd, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8-sig", errors="replace")

    last_date, last_rate = None, None
    for line in text.splitlines():
        cols = line.split(",")
        if len(cols) < 2:
            continue
        iso = parse_rba_date(cols[0])
        if not iso:
            continue
        try:
            aud_usd = float(cols[1])
        except ValueError:
            continue
        if aud_usd > 0:
            last_date, last_rate = iso, aud_usd

    if last_date is None:
        raise RuntimeError("no parsable data rows in F11 CSV")

    usd_aud = 1.0 / last_rate
    return raw, sha, last_date, usd_aud, last_rate, text


def previous_rate_for(published_date_iso):
    res = q(
        "SELECT rate FROM cb_rate_extractions "
        f"WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        f"AND published_date='{published_date_iso}' "
        "ORDER BY extracted_at DESC LIMIT 1")
    return float(res) if res else None


def write_extraction(raw_bytes, sha, published_date_iso, usd_aud, aud_usd, raw_text):
    raw_json = json.dumps({
        "format": "csv",
        "encoding": "utf-8",
        "aud_usd_as_published": aud_usd,
        "inversion": "USD/AUD = 1 / (A$1=USD)",
        "raw_text": raw_text,
        "raw_byte_count": len(raw_bytes),
    }).replace("'", "''")
    notes_sql = NOTES.replace("'", "''")
    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload, notes) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{published_date_iso}', {usd_aud}, '{SOURCE_URL}', '{sha}', "
        f"'{raw_json}'::jsonb, '{notes_sql}') "
        "ON CONFLICT DO NOTHING RETURNING id;")
    res = q(sql)
    if res:
        log(f"appended extraction id={res}")
        return True
    log("extraction was duplicate  -  no-op")
    return False


def upsert_exchange_rate(published_date_iso, usd_aud):
    bucket_ts = f"{published_date_iso} 00:00:00+00"
    sql = (
        "INSERT INTO exchange_rates "
        "(source_currency, target_currency, bucket_ts, granularity, product, "
        " rate, tier, composite, composite_via, provider_count, status, "
        " fetched_at, computed_at, provenance, source_authority) "
        f"VALUES ('USD', '{TARGET_CCY}', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_aud}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;")
    return q(sql, return_output=False) is not None


def main():
    log("=== RBA scrape start ===")
    raw, sha, published_date, usd_aud, aud_usd, raw_text = fetch_rba()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  A$1=USD {aud_usd:.4f}  USD/AUD={usd_aud:.6f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_aud) > 1e-9:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.6f} new={usd_aud:.6f}")

    appended = write_extraction(raw, sha, published_date, usd_aud, aud_usd, raw_text)
    upsert_exchange_rate(published_date, usd_aud)

    log(f"=== RBA scrape done (appended={appended}) ===")


if __name__ == "__main__":
    main()
