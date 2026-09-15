#!/usr/bin/env python3
"""ORBI Tier 3  -  Bank of Algeria USD/DZD scraper.

Bank of Algeria (Banque d'Algérie) publishes the daily interbank reference
"cotation d'ouverture" (opening quotation) of the Algerian Dinar against
major currencies on an Elementor-rendered WordPress page. There is no JSON
or XML feed  -  we parse the HTML table at:

    https://www.bank-of-algeria.dz/taux-de-change-journalier/

The page renders a row of single-day tables in reverse-chronological order;
the first (left-most) table is the current trading day. Each table has a
DD-MM-YYYY header and a tbody whose first <tr> is USD followed by the rate
in DZD per 1 USD.

TLS note: the BoA web server presents only the leaf cert. We supply the
DigiCert Global G2 TLS RSA SHA256 2020 CA1 intermediate at
/opt/bb-support/ca-extras/digicert-g2-rsa-sha256-2020-ca1.pem so verification
succeeds.

Methodology spec: https://wiki.abascal.ca/doc/central-bank-rate-extractions-append-only-audit-trail-Mn9ADGAwiV
"""
import hashlib
import html as H
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

LOG = "/var/log/orbi/cb-bank-of-algeria-dzd.log"
SOURCE_URL = "https://www.bank-of-algeria.dz/taux-de-change-journalier/"
SOURCE_AUTHORITY = "BANK_OF_ALGERIA"
SOURCE_CCY = "USD"
TARGET_CCY = "DZD"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
EXTRA_CA = "/opt/bb-support/ca-extras/digicert-g2-rsa-sha256-2020-ca1.pem"


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
    # Pass SQL on stdin to avoid argv length limits (raw_payload can be ~500KB).
    r = subprocess.run(["psql", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True,
                       timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip() if return_output else ""


def _ssl_ctx():
    ctx = ssl.create_default_context()
    if os.path.exists(EXTRA_CA):
        ctx.load_verify_locations(EXTRA_CA)
    return ctx


def fetch_boa():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text)."""
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx()) as resp:
        raw = resp.read()
    sha = hashlib.sha256(raw).hexdigest()

    text = raw.decode("utf-8")

    # Find the first per-day table block on the page. Each table header is
    #   <th>DD-MM-YYYY</th>
    # followed by a tbody whose first <tr><td>USD</td><td>RATE</td>.
    # We anchor on the FIRST USD row and walk backwards to find the matching
    # DD-MM-YYYY date that precedes it.

    usd_match = re.search(r"<td>\s*USD\s*</td>\s*<td>\s*([0-9]+(?:\.[0-9]+)?)\s*</td>", text)
    if not usd_match:
        raise RuntimeError("USD <td> row not found on BoA daily page")
    usd_rate = float(usd_match.group(1))

    head = text[:usd_match.start()]
    date_matches = re.findall(r"\b(\d{2})-(\d{2})-(\d{4})\b", head)
    if not date_matches:
        raise RuntimeError("No DD-MM-YYYY header found before USD row")
    d, m, y = date_matches[-1]
    published_date = date(int(y), int(m), int(d)).isoformat()

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
        f"VALUES ('USD', 'DZD', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== Bank of Algeria scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_boa()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/DZD={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f} delta={usd_rate - prev:+.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== Bank of Algeria scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
