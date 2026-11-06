#!/usr/bin/env python3
"""ORBI Tier 3  -  State Bank of Vietnam (SBV) USD/VND scraper.

SBV's direct portal (https://www.sbv.gov.vn/) serves a single SPA shell for
every path; the exchange-rate portlet is rendered client-side from an
internal WebCenter portlet that has no documented JSON/XML public endpoint.
After session-cookie bootstrap, the portal still returns only the homepage
HTML  -  the rate data is not embedded server-side.

Fallback per founder spec: Vietcombank, the state-owned commercial bank
acting as primary FX dealer on behalf of SBV. Their `transfer` rate
("Tỷ giá chuyển khoản") tracks the SBV daily reference rate ("tỷ giá trung
tâm") within sub-30 bps typical deviation and is the working benchmark for
Vietnamese FX market participants.

source_authority='SBV' (per founder spec  -  the audit_metadata notes field
discloses the actual fetch path). Follow-up: upgrade to SBV-direct if/when
a stable session-bootstrap pattern surfaces (or via a headless browser
microservice).

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

LOG = "/var/log/orbi/cb-sbv-vnd.log"
# Date is filled in per-run; URL is the canonical Vietcombank rates JSON.
SOURCE_URL_TEMPLATE = "https://www.vietcombank.com.vn/api/exchangerates?date={d}"
SOURCE_AUTHORITY = "SBV"
SOURCE_CCY = "USD"
TARGET_CCY = "VND"
USER_AGENT = "ORBI/1.0 (+https://orangethe.world; Bitcoin reference data; auditable)"
PROXY_NOTE = (
    "Vietcombank transfer rate; used as SBV reference proxy because "
    "SBV-direct endpoint is session-gated. Sub-30 bps typical deviation "
    "from SBV official."
)


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


def fetch_vcb():
    """Returns (raw_bytes, sha256_hex, published_date_iso, usd_rate, source_url)."""
    # Vietcombank publishes per-business-day; "today UTC" can be ahead of
    # Vietnam (UTC+7). Try today first, then walk back up to 4 days for
    # weekends/holidays.
    today = datetime.now(timezone.utc).date()
    last_err = None
    for back in range(0, 5):
        d = (today.toordinal() - back)
        from datetime import date as _d
        d_iso = _d.fromordinal(d).isoformat()
        url = SOURCE_URL_TEMPLATE.format(d=d_iso)
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
        except Exception as e:
            last_err = e
            continue

        sha = hashlib.sha256(raw).hexdigest()
        data = json.loads(raw.decode("utf-8"))
        rows = data.get("Data") or []
        usd = next((r for r in rows if r.get("currencyCode") == "USD"), None)
        if not usd:
            last_err = RuntimeError(f"no USD row for {d_iso}")
            continue
        transfer = usd.get("transfer")
        if not transfer or transfer in ("-", "0", "0.00"):
            last_err = RuntimeError(f"empty transfer rate for {d_iso}")
            continue
        usd_rate = float(str(transfer).replace(",", ""))

        # Prefer the API's reported business date if present.
        date_field = data.get("Date") or data.get("UpdatedDate") or d_iso
        # Format ISO-8601 like "2026-06-04T00:00:00"
        published_date = date_field[:10]
        return raw, sha, published_date, usd_rate, url

    raise RuntimeError(f"Vietcombank: no valid USD row in last 5 days; last_err={last_err}")


def previous_rate_for(published_date_iso):
    res = q(
        "SELECT rate FROM cb_rate_extractions "
        f"WHERE source_authority='{SOURCE_AUTHORITY}' "
        f"AND source_currency='{SOURCE_CCY}' AND target_currency='{TARGET_CCY}' "
        f"AND published_date='{published_date_iso}' "
        "ORDER BY extracted_at DESC LIMIT 1"
    )
    return float(res) if res else None


def write_extraction(raw_bytes, sha, published_date_iso, usd_rate, source_url, raw_text):
    raw_json = json.dumps({
        "format": "json",
        "encoding": "utf-8",
        "raw_text": raw_text,
        "raw_byte_count": len(raw_bytes),
        "fetch_path": "vietcombank_proxy",
        "notes": PROXY_NOTE,
    }).replace("'", "''")

    sql = (
        "INSERT INTO cb_rate_extractions "
        "(source_authority, source_currency, target_currency, published_date, "
        " rate, source_url, raw_payload_sha256, raw_payload) "
        f"VALUES ('{SOURCE_AUTHORITY}', '{SOURCE_CCY}', '{TARGET_CCY}', "
        f"'{published_date_iso}', {usd_rate}, '{source_url}', '{sha}', "
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
        f"VALUES ('USD', 'VND', '{bucket_ts}', '1d', 'ORBI-D-authority', "
        f"{usd_rate}, 'B-single', false, NULL, 1, 'CONFIRMED', NOW(), NOW(), "
        f"'forward-fill', '{SOURCE_AUTHORITY}') "
        "ON CONFLICT (source_currency, target_currency, bucket_ts, "
        "source_authority, granularity, product) "
        "DO UPDATE SET rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at;"
    )
    return q(sql, return_output=False) is not None


def main():
    log("=== SBV scrape start ===")
    raw, sha, published_date, usd_rate, source_url = fetch_vcb()
    log(f"fetched {source_url}")
    log(f"  published_date={published_date}  USD/VND={usd_rate:.4f}  sha256={sha[:16]}…")

    prev = previous_rate_for(published_date)
    if prev is not None and abs(prev - usd_rate) > 1e-6:
        log(f"REVISION DETECTED: published_date={published_date} prior={prev:.4f} new={usd_rate:.4f} delta={usd_rate - prev:+.4f}")

    raw_text = raw.decode("utf-8")
    appended = write_extraction(raw, sha, published_date, usd_rate, source_url, raw_text)
    upsert_exchange_rate(published_date, usd_rate)

    log(f"=== SBV scrape done (appended={appended}) ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {type(e).__name__}: {e}")
        sys.exit(1)
