#!/usr/bin/env python3
"""
Phase H  -  FED H.10 daily FX loader → exchange_rates (source_authority='FED')

Series (FRED API, daily H.10):
  DEXUSEU  USD per EUR        → INVERT → USD->EUR
  DEXJPUS  JPY per USD        → direct → USD->JPY
  DEXCAUS  CAD per USD        → direct → USD->CAD
  DEXUSUK  USD per GBP        → INVERT → USD->GBP
  DEXSZUS  CHF per USD        → direct → USD->CHF
  DEXMXUS  MXN per USD        → direct → USD->MXN
  DEXBZUS  BRL per USD        → direct → USD->BRL
  DEXINUS  INR per USD        → direct → USD->INR
  DEXUSAL  USD per AUD        → INVERT → USD->AUD

Canonical storage: source_currency='USD', target_currency=<fiat>, rate = fiat per 1 USD.
Daily forward-fill; FRED back-revises occasionally so we re-pull a 90-day window each run.
Companion script to the 2026-05-27 105K one-shot backfill (legacy rows used pre-inversion
convention for EUR/GBP/AUD; reconciliation tracked separately).

Source: api.stlouisfed.org. License: FRED API ToS; underlying H.10 is US-Fed public.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from orbi_continuity import continuity_check_end_of_run
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fed-h10.log"
SLEEP_BETWEEN = 1
LOOKBACK_DAYS = 90  # re-pull window for revisions; ON CONFLICT DO NOTHING

# (fred_id, target_ccy, invert)
SERIES = [
    ("DEXUSEU", "EUR", True),
    ("DEXJPUS", "JPY", False),
    ("DEXCAUS", "CAD", False),
    ("DEXUSUK", "GBP", True),
    ("DEXSZUS", "CHF", False),
    ("DEXMXUS", "MXN", False),
    ("DEXBZUS", "BRL", False),
    ("DEXINUS", "INR", False),
    ("DEXUSAL", "AUD", True),
]


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass


def signal_alert(subject, body=""):
    try:
        subprocess.run(["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body], timeout=15)
    except Exception:
        pass


def fred_key():
    k = os.environ.get("FRED_API_KEY", "").strip()
    if not k:
        raise RuntimeError("FRED_API_KEY missing from env (wrap with with-secret.py)")
    return k


def fetch_series(series_id, api_key, start_date):
    url = ("https://api.stlouisfed.org/fred/series/observations"
           f"?series_id={series_id}&api_key={api_key}&file_type=json"
           f"&observation_start={start_date}")
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            log(f"  {series_id} HTTP {e.code}: {e.read().decode()[:200]}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {series_id} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def build_rows(series_id, target_ccy, invert, observations, fetched_at_iso):
    rows = []
    for o in observations:
        v = o.get("value")
        if not v or v == ".":
            continue
        try:
            val = Decimal(v)
        except Exception:
            continue
        if val <= 0:
            continue
        try:
            ds = datetime.strptime(o["date"], "%Y-%m-%d").date()
        except Exception:
            continue
        if invert:
            val = Decimal(1) / val
        bucket_ts = datetime(ds.year, ds.month, ds.day, tzinfo=timezone.utc).isoformat()
        rows.append([
            "USD",                # source_currency
            target_ccy,           # target_currency
            bucket_ts,            # bucket_ts
            "1d",                 # granularity
            "ORBI-D-authority",   # product
            f"{val:.8f}",         # rate
            "B-single",           # tier
            "false",              # composite
            "",                   # composite_via (NULL)
            "1",                  # provider_count
            "CONFIRMED",          # status
            "",                   # superseded_by_id (NULL)
            fetched_at_iso,       # fetched_at
            fetched_at_iso,       # computed_at
            "forward-fill",       # provenance
            "FED",                # source_authority
        ])
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else v.replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("source_currency, target_currency, bucket_ts, granularity, product, rate, "
            "tier, composite, composite_via, provider_count, status, superseded_by_id, "
            "fetched_at, computed_at, provenance, source_authority")
    script = (
        "CREATE TEMP TABLE _stg_fedh10 (LIKE exchange_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_fedh10 ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO exchange_rates ({cols}) "
        f"SELECT {cols} FROM _stg_fedh10 ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_fedh10;\n"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orbi", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        log("  flush TIMEOUT after 600s; sleeping 60s and skipping batch")
        time.sleep(60)
        return -1
    if r.returncode != 0:
        log(f"  flush FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def main():
    log("=== Phase H FED H.10 daily FX loader start ===")
    api_key = fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    start_date = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    grand = 0
    for series_id, target_ccy, invert in SERIES:
        log(f"[{series_id}] fetching USD->{target_ccy} (invert={invert}) since {start_date}")
        d = fetch_series(series_id, api_key, start_date)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations")
        rows = build_rows(series_id, target_ccy, invert, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows")
            grand += n
        time.sleep(SLEEP_BETWEEN)

    for _sid, _ccy, _inv in SERIES:
        try:
            continuity_check_end_of_run("FED", "USD", _ccy)
        except Exception as e:
            log(f"continuity check USD->{_ccy} failed (suppressed): {e}")

    log(f"=== done: {grand} rows wrote across {len(SERIES)} series ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        signal_alert("ORBI H FED H.10 FAILED", str(e)[:200])
        sys.exit(1)
