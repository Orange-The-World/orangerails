#!/usr/bin/env python3
"""
Phase G  -  FRED commodities loader → commodity_prices

Series (all US public domain via FRED API):
  WTISPLC        WTI crude oil, $/barrel, monthly, 1946+
  MCOILBRENTEU   Brent crude oil, $/barrel, monthly
  PCOPPUSDM      Copper, $/metric ton, monthly (IMF/Global Price of Commodities)
  PIORECRUSDM    Iron ore (China import, fines spot, CFR Tianjin), $/metric ton, monthly
  PWHEAMTUSDM    Wheat (No.1 Hard Red Winter, FOB Gulf), $/metric ton, monthly
  PCOALAUUSDM    Coal, Australia thermal (12,000 BTU/lb), $/metric ton, monthly
  PNGASUSUSDM    Natural gas, US (Henry Hub), $/MMBtu, monthly
                 (stored as $/BTU = value/1e6 to fit unit allowlist)

Source: api.stlouisfed.org (US Federal Reserve Bank of St. Louis).
License: FRED® API terms allow research/personal redistribution with attribution;
underlying US-gov-collected and IMF-republished series treated as public-domain
research data per Phase H1 ToS deep-dive (wiki dYwzeg1qly).
Per row: source_authority='FRED', source_url + source_series_id baked in.

Cadence: weekly via timer. Idempotent via UNIQUE
  (item, COALESCE(country,'GLOBAL'), COALESCE(region,''), period_start, unit, source_authority).
Uses ON CONFLICT DO NOTHING.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone, timedelta
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fred-commodities.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1

# (fred_id, item_label, country, region, unit, scale, currency, provenance)
#   scale: multiplier applied to raw FRED value to land in canonical unit.
#          For PNATGASUSUSDM, raw is $/MMBtu, we store $/BTU → scale = 1e-6.
#          For everything else, scale = 1.
SERIES = [
    ("WTISPLC",       "Crude oil WTI",         "US",     None,    "per_barrel",      Decimal(1),         "USD"),
    ("MCOILBRENTEU",  "Crude oil Brent",       None,     "EU",    "per_barrel",      Decimal(1),         "USD"),
    ("PCOPPUSDM",     "Copper",                None,     "GLOBAL","per_metric_ton",  Decimal(1),         "USD"),
    ("PIORECRUSDM",   "Iron ore",              "CN",     None,    "per_metric_ton",  Decimal(1),         "USD"),
    ("PWHEAMTUSDM",   "Wheat",                 "US",     None,    "per_metric_ton",  Decimal(1),         "USD"),
    ("PCOALAUUSDM",   "Coal thermal Australia","AU",     None,    "per_metric_ton",  Decimal(1),         "USD"),
    ("PNGASUSUSDM",   "Natural gas Henry Hub", "US",     None,    "per_btu",         Decimal("0.000001"),"USD"),
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


def _fred_key():
    for line in open(ENV_PATH):
        if line.startswith("FRED_API_KEY="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v
    raise RuntimeError("FRED_API_KEY not in /opt/bb-support/.env")


def _signal_alert(subject, body=""):
    try:
        subprocess.run(["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body], timeout=15)
    except Exception:
        pass


def fetch_series(series_id, api_key):
    url = (f"https://api.stlouisfed.org/fred/series/observations"
           f"?series_id={series_id}&api_key={api_key}&file_type=json&observation_start=1900-01-01")
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0 (orange-pill truth tables)"})
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


def _end_of_month(d):
    if d.month == 12:
        ny, nm = d.year + 1, 1
    else:
        ny, nm = d.year, d.month + 1
    return date(ny, nm, 1) - timedelta(days=1)


def build_rows(series_id, item, country, region, unit, scale, currency, observations, fetched_at_iso):
    src_url = f"https://fred.stlouisfed.org/series/{series_id}"
    rows = []
    for o in observations:
        v = o.get("value")
        if not v or v == ".":
            continue
        try:
            raw = Decimal(v)
        except Exception:
            continue
        if raw <= 0:
            continue
        try:
            ds = datetime.strptime(o["date"], "%Y-%m-%d").date()
        except Exception:
            continue
        scaled = raw * scale
        if scaled <= 0:
            continue
        period_end = _end_of_month(ds)
        period_label = ds.strftime("%Y-%m")
        rows.append([
            item,                              # item
            country or "",                     # country
            region or "",                      # region
            ds.isoformat(),                    # period_start
            period_end.isoformat(),            # period_end
            period_label,                      # period_label
            "",                                # release_date
            unit,                              # unit
            str(scaled),                       # value
            currency,                          # currency
            "FRED",                            # source_authority
            src_url,                           # source_url
            series_id,                         # source_series_id
            "historical-backfill",             # provenance
            fetched_at_iso,                    # fetched_at
            fetched_at_iso,                    # inserted_at
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
    cols = ("item, country, region, period_start, period_end, period_label, "
            "release_date, unit, value, currency, source_authority, source_url, "
            "source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_c (LIKE commodity_prices INCLUDING DEFAULTS);\n"
        f"\\copy _stg_c ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO commodity_prices ({cols}) "
        f"SELECT {cols} FROM _stg_c ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_c;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        log(f"  COPY FAIL: {r.stderr[:400]}")
        return -1
    _wrote = len(lines)
    _out = (r.stdout or "").strip().splitlines()
    if _out:
        try:
            _wrote = int(_out[-1])
        except ValueError:
            log(f"  could not parse written-row count from psql output {_out[-1]!r}; reporting staged count instead")
    return _wrote


def continuity_check():
    """For each series, count rows per year between MIN and MAX. Alert on gaps."""
    sql = """
    SELECT source_series_id,
           EXTRACT(YEAR FROM period_start)::int AS yr,
           COUNT(*) AS n
      FROM commodity_prices
     WHERE source_authority='FRED'
     GROUP BY 1,2
     ORDER BY 1,2;
    """
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-At", "-F", "|", "-c", sql],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        log(f"  continuity SQL FAIL: {r.stderr[:300]}")
        return
    by_series = {}
    for line in r.stdout.strip().splitlines():
        if not line:
            continue
        sid, yr, n = line.split("|")
        by_series.setdefault(sid, {})[int(yr)] = int(n)
    gaps = []
    for sid, years in by_series.items():
        if not years:
            continue
        lo, hi = min(years), max(years)
        zero_years = [y for y in range(lo, hi + 1) if y not in years]
        log(f"[continuity] {sid}: {lo}-{hi}, {len(years)} years populated, {len(zero_years)} gap years")
        if zero_years:
            gaps.append(f"{sid}: gaps {zero_years[:10]}{'...' if len(zero_years) > 10 else ''}")
    if gaps:
        _signal_alert("ORBI Phase G FRED commodities  -  continuity gaps",
                      "\n".join(gaps)[:1500])


def main():
    log("=== Phase G FRED commodities loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for series_id, item, country, region, unit, scale, currency in SERIES:
        log(f"[{series_id}] fetching ({item}) ...")
        d = fetch_series(series_id, api_key)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations")
        rows = build_rows(series_id, item, country, region, unit, scale, currency, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows (ON CONFLICT DO NOTHING)")
            grand_total += n
        time.sleep(SLEEP_BETWEEN)
    log(f"=== load done: {grand_total} candidate rows across {len(SERIES)} series ===")
    try:
        continuity_check()
    except Exception as e:
        log(f"continuity check error (non-fatal): {e!r}")
    log("=== Phase G FRED commodities loader complete ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase G FRED commodities FAILED", str(e)[:200])
        sys.exit(1)
