#!/usr/bin/env python3
"""ORBI Tier 3  -  Bank Al-Maghrib (BAM) USD/MAD scraper.

BAM publishes daily reference rates ("Cours de référence") via a CSV export
on bkam.ma. The export contains today's and the previous business day's mean
rates for ~30 currencies in semicolon-delimited form with comma decimals.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-bam-mad.log"
SOURCE_URL = (
    "https://www.bkam.ma/export/blockcsv/4550/"
    "5312b6def4ad0a94c5a992522868ac0a/"
    "cc51b5ce6878a3dc655dae26c47fddf8"
    "?block=cc51b5ce6878a3dc655dae26c47fddf8"
)
SOURCE_AUTHORITY = "BAM"
SOURCE_CCY = "USD"
TARGET_CCY = "MAD"
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


def fetch_bam():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text).

    BAM CSV format (semicolon-delimited, UTF-8):
      "Cours de référence"
      "<a href='...'>Service API Cours de référence</a>"
      ;DD/MM/YYYY;DD/MM/YYYY        <-- header row: two most recent business days
      Devises;Moyen;Moyen
      "1 EURO";10,6947;10,6822
      "1 DOLLAR U.S.A.";9,2126;9,2026
      ...
    Decimals use comma; today's rate is column 1 (index 1 after Devises name).
    """
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8")

    # Parse semicolon CSV.
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))

    # Find the date header row: first cell empty, next cells DD/MM/YYYY.
    published_date = None
    for row in rows:
        if len(row) >= 2 and row[0] == "" and re.match(r"^\d{2}/\d{2}/\d{4}$", row[1].strip()):
            d, m, y = row[1].strip().split("/")
            published_date = date(int(y), int(m), int(d)).isoformat()
            break
    if not published_date:
        raise RuntimeError("BAM CSV missing date header row")

    # Find USD row.
    usd_rate = None
    for row in rows:
        if not row:
            continue
        label = row[0].strip().strip('"').upper()
        if "DOLLAR U.S.A" in label or "DOLLAR USA" in label or label == "1 DOLLAR U.S.A.":
            if len(row) < 2:
                raise RuntimeError(f"BAM USD row truncated: {row}")
            raw_val = row[1].strip().replace(",", ".")
            usd_rate = float(raw_val)
            # Nominal is "1 DOLLAR U.S.A."  -  already per-unit. Defensive guard:
            m = re.match(r"^(\d+)\s", label)
            if m and int(m.group(1)) != 1:
                usd_rate = usd_rate / int(m.group(1))
            break
    if usd_rate is None:
        raise RuntimeError("BAM CSV missing USD row")

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
        "format": "csv",
        "encoding": "utf-8",
        "delimiter": ";",
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
        f"VALUES ('USD', 'MAD', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== BAM scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_bam()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/MAD={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== BAM scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
