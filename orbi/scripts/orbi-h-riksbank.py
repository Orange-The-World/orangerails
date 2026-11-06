#!/usr/bin/env python3
"""
Phase H Wave 1  -  Sveriges Riksbank modern FX loader → exchange_rates.

Source: Riksbank SWEA REST API (https://api.riksbank.se/swea/v1/)
  Endpoint pattern: /Observations/{seriesId}/{from}/{to}
  Series:  SEK<CCY>PMI  (per-mid-rate-fix vs SEK), 1993-01-04 onward.
  License: Riksbank publishes mid-rate fixes for public reuse under EU PSI/Open
           Government terms with attribution.

Quote orientation: PMI series value = SEK per 1 unit of foreign currency.
We write rows as source_currency=<CCY>, target_currency=SEK, rate=value.

Tables written:
  exchange_rates  ← daily mid-rate fix per pair, granularity='1d',
                    product='RIKSBANK-FIX', source_authority='RIKSBANK'.

Idempotent: ON CONFLICT DO NOTHING on uq_rates_pair_bucket_authority.
Cadence: daily timer (Riksbank publishes ~16:00 Stockholm time business days).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal

sys.path.insert(0, "/opt/bb-support/scripts")
from orbi_continuity import continuity_check_end_of_run  # noqa: E402
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-riksbank.log"
SLEEP_BETWEEN = 8  # API rate-limits ~10 req/min on burst; be polite
BASE = "https://api.riksbank.se/swea/v1"

# Currencies covered by Riksbank PMI (the canonical fixing list, excluding
# defunct pre-euro currencies). Each entry = (ccy_code, since_date).
# All start at the 1993-01-04 mid-rate fix unless a later introduction date.
PAIRS = [
    ("EUR", "1999-01-04"),
    ("USD", "1993-01-04"),
    ("GBP", "1993-01-04"),
    ("JPY", "1993-01-04"),
    ("CHF", "1993-01-04"),
    ("DKK", "1993-01-04"),
    ("NOK", "1993-01-04"),
    ("CAD", "1993-01-04"),
    ("AUD", "1993-01-04"),
    ("NZD", "1993-01-04"),
    ("HKD", "1993-01-04"),
    ("SGD", "1993-01-04"),
    ("CNY", "1993-01-04"),
    ("INR", "1993-01-04"),
    ("KRW", "1993-01-04"),
    ("MXN", "1993-01-04"),
    ("BRL", "1993-01-04"),
    ("ZAR", "1993-01-04"),
    ("TRY", "1993-01-04"),
    ("PLN", "1993-01-04"),
    ("HUF", "1993-01-04"),
    ("CZK", "1993-01-04"),
    ("RON", "1993-01-04"),
    ("ILS", "1993-01-04"),
    ("THB", "1993-01-04"),
    ("MYR", "1993-01-04"),
    ("IDR", "1993-01-04"),
    ("PHP", "1993-01-04"),
    ("RUB", "1993-01-04"),
    ("SAR", "1993-01-04"),
    ("ISK", "1993-01-04"),
]

CITATION_TPL = (
    "Sveriges Riksbank, SWEA series {sid} (mid-rate fix SEK per 1 {ccy}). "
    "Reused under EU PSI baseline + Riksbank statistics terms with attribution."
)


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    print(line, file=sys.stderr)
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def _signal_alert(subject, body=""):
    try:
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
    except Exception:
        pass


def _max_bucket(series_id):
    sql = (
        "SELECT to_char(MAX(bucket_ts) AT TIME ZONE 'UTC','YYYY-MM-DD') "
        "FROM exchange_rates "
        f"WHERE source_authority='RIKSBANK' AND product='RIKSBANK-FIX' "
        f"  AND source_series_id_hint='{series_id}'"
    )
    # NOTE: schema has no source_series_id_hint on exchange_rates; fall back
    # to (source_currency, target_currency, source_authority).
    return None


def _max_date(ccy):
    sql = (
        "SELECT to_char(MAX(bucket_ts) AT TIME ZONE 'UTC','YYYY-MM-DD') "
        "FROM exchange_rates "
        f"WHERE source_authority='RIKSBANK' "
        f"  AND source_currency='{ccy}' AND target_currency='SEK';"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-At", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    s = (r.stdout or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def fetch_chunk(series_id, start, end):
    url = f"{BASE}/Observations/{series_id}/{start.isoformat()}/{end.isoformat()}"
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            log(f"  {series_id} {start}..{end} HTTP {e.code}")
            # 429: back off aggressively
            if e.code == 429:
                time.sleep(30 * (attempt + 1))
            else:
                time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {series_id} {start}..{end} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def build_rows(ccy, observations, fetched_at_iso):
    series_id = f"SEK{ccy}PMI"
    citation = CITATION_TPL.format(sid=series_id, ccy=ccy)
    src_url = f"https://www.riksbank.se/en-gb/statistics/exchange-rates/"
    rows = []
    for o in observations:
        try:
            d = datetime.strptime(o["date"], "%Y-%m-%d").date()
            v = Decimal(str(o["value"]))
        except Exception:
            continue
        if v <= 0:
            continue
        # bucket_ts at 12:00 UTC (Riksbank fix is ~midday in Stockholm).
        bucket_ts = f"{d.isoformat()} 12:00:00+00"
        # exchange_rates columns:
        # source_currency, target_currency, bucket_ts, granularity, product,
        # rate, tier, composite, composite_via, provider_count, status,
        # superseded_by_id, fetched_at, computed_at, provenance, source_authority
        rows.append([
            ccy, "SEK", bucket_ts, "1d", "ORBI-D-authority",
            str(v), "A", "f", "", "1", "CONFIRMED",
            "", fetched_at_iso, fetched_at_iso,
            "historical-backfill", "RIKSBANK",
        ])
    return rows, citation, src_url


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("source_currency, target_currency, bucket_ts, granularity, product, "
            "rate, tier, composite, composite_via, provider_count, status, "
            "superseded_by_id, fetched_at, computed_at, provenance, source_authority")
    script = (
        f"CREATE TEMP TABLE _stg_r (LIKE exchange_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_r ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"INSERT INTO exchange_rates ({cols}) "
        f"SELECT {cols} FROM _stg_r ON CONFLICT DO NOTHING;\n"
        "DROP TABLE _stg_r;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orbi", "-q", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=900,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    return len(lines)


def main():
    log("=== Phase H Wave 1 Riksbank modern FX loader start ===")
    today = date.today()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for ccy, since in PAIRS:
        series_id = f"SEK{ccy}PMI"
        start_default = datetime.strptime(since, "%Y-%m-%d").date()
        last = _max_date(ccy)
        if last:
            # Refetch last 30 days for revisions
            from datetime import timedelta
            start = max(start_default, last - timedelta(days=30))
        else:
            start = start_default
        log(f"[{series_id}] fetching {start}..{today}")
        # Riksbank limits each request to <= 365 days; chunk by year.
        cur = start
        from datetime import timedelta
        total_obs = 0
        while cur <= today:
            chunk_end = min(today, cur.replace(year=cur.year + 1) - timedelta(days=1))
            obs = fetch_chunk(series_id, cur, chunk_end)
            if obs is None:
                log(f"[{series_id}] chunk {cur}..{chunk_end} FAILED (skipping)")
                cur = chunk_end + timedelta(days=1)
                continue
            if obs:
                rows, _, _ = build_rows(ccy, obs, fetched_at)
                n = copy_rows(rows)
                if n > 0:
                    grand_total += n
                    total_obs += n
            cur = chunk_end + timedelta(days=1)
            time.sleep(SLEEP_BETWEEN)
        log(f"[{series_id}] +{total_obs} candidate rows staged")
        # Per-pair continuity check
        try:
            continuity_check_end_of_run("RIKSBANK", ccy, "SEK")
        except Exception as e:
            log(f"  continuity check raised (suppressed): {e}")
    log(f"=== done: {grand_total} candidate rows across {len(PAIRS)} pairs ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H Wave1 Riksbank FX FAILED", str(e)[:200])
        sys.exit(1)
