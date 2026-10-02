#!/usr/bin/env python3
"""ORBI Tier 3  -  Central Bank of Kenya (CBK) USD/KES scraper.

CBK publishes daily KES exchange rates via a wpDataTables widget on:
  https://www.centralbank.go.ke/rates/forex-exchange-rates/

The page is pre-rendered with the latest 25 rows of the table. We parse the
HTML for the row whose currency cell equals "US DOLLAR" / "USD" and read
its mean / buy / sell columns. The mean is the CBK authoritative rate.

ToS: CBK /terms-of-use returns 404; rates are public sovereign-reference
data. Attribution "Central Bank of Kenya" in notes.

KNOWN OPERATIONAL GAP: as of 2026-06-06 the bb-support egress IP
(66.70.179.236) is on Sucuri WebSite Firewall's IP blacklist (BLACK02) for
www.centralbank.go.ke (any path / any User-Agent → 403). The scraper is
fully built and verified to work from other egress IPs (confirmed working
from Jarvis). Until the bb-support IP is whitelisted (open a Sucuri
support ticket or migrate egress), this service exits non-zero with
"FETCH_BLOCKED". Follow-up: contact CBK web admin / Sucuri support to
request unblock of 66.70.179.236.

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

LOG = "/var/log/orbi/cb-cbk-kes.log"
SOURCE_URL = "https://www.centralbank.go.ke/rates/forex-exchange-rates/"
SOURCE_AUTHORITY = "CBK"
SOURCE_CCY = "USD"
TARGET_CCY = "KES"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ORBI/1.0 (+https://orangethe.world)"
NOTES = "Central Bank of Kenya daily mean USD/KES rate (CBK official)"


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


def fetch_cbk():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, raw_text).

    CBK rows in HTML follow the wpDataTables structure:
      <tr id="table_32_row_N">
        <td>DD/MM/YYYY</td>       date_r
        <td>US DOLLAR</td>        currency
        <td>MEAN</td>             new_mean
        <td>BUY</td>              new_buy
        <td>SELL</td>             new_sell
      </tr>
    """
    req = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()

    text = raw.decode("utf-8", errors="replace")
    if "sucuri" in text.lower() and "access denied" in text.lower():
        raise RuntimeError("FETCH_BLOCKED: Sucuri WAF blocked bb-support egress IP")

    sha = hashlib.sha256(raw).hexdigest()

    # CBK pre-renders rows. Date is DD/MM/YYYY.
    row_pat = re.compile(
        r"<tr[^>]*table_32_row_\d+[^>]*>\s*"
        r"<td[^>]*>\s*(\d{1,2}/\d{1,2}/\d{4})\s*</td>\s*"
        r"<td[^>]*>\s*([^<]+?)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>\s*"
        r"<td[^>]*>\s*([0-9.,]+)\s*</td>",
        re.IGNORECASE,
    )
    rows = row_pat.findall(text)
    if not rows:
        raise RuntimeError("CBK: no table rows parsed")

    usd_row = None
    for d_str, ccy, mean, buy, sell in rows:
        c = ccy.strip().upper().rstrip(".")
        if c in ("US DOLLAR", "USD", "U.S. DOLLAR"):
            usd_row = (d_str, mean, buy, sell)
            break
    if usd_row is None:
        raise RuntimeError("CBK USD/KES row not found in first 25 rows")

    d_str, mean, buy, sell = usd_row
    dd, mm, yyyy = d_str.split("/")
    published_date = date(int(yyyy), int(mm), int(dd)).isoformat()
    usd_rate = float(mean.replace(",", ""))

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
    log("=== CBK scrape start ===")
    raw, sha, published_date, usd_rate, raw_text = fetch_cbk()
    log(f"fetched {SOURCE_URL}")
    log(f"  published_date={published_date}  USD/KES={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f}")

    appended = write_extraction(raw, sha, published_date, usd_rate, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== CBK scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
