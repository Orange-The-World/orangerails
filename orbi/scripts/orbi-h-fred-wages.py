#!/usr/bin/env python3
"""
Phase G  -  FRED wages loader → wages

Onboarded sources (all via FRED republication; underlying = BLS/OECD; all GO
per Phase G ToS posture doc wiki.abascal.ca/doc/...FMhaCwdAiI and Phase H1
verified-ToS pattern wiki.abascal.ca/doc/...dYwzeg1qly).

US series (BLS-authored, US-Gov public domain, 17 U.S.C. § 105):
  CES0500000003   Avg Hourly Earnings, All Employees, Total Private (USD/hr, M, 2006+)
  AHETPI          Avg Hourly Earnings, Production & Nonsupervisory, Total Private (USD/hr, M, 1964+)
  CES3000000008   Avg Hourly Earnings, Production, Manufacturing (USD/hr, M, 1939+)
  CES0500000011   Avg Weekly Earnings, All Employees, Total Private (USD/wk, M, 2006+)
  FEDMINNFRWG     Federal Minimum Hourly Wage, Nonfarm Workers (USD/hr, M, 1938+)

International series (OECD-curated, republished on FRED, level-form in local
currency only  -  index-form series excluded because wages.value > 0 + currency
semantics don't fit an index):
  LCEAMN01CAM189S Hourly earnings, manufacturing, Canada (CAD/hr, M, 1956+)
  LCEAMN01SEM189N Hourly earnings, manufacturing, Sweden (SEK/hr, M, 1971+)
  LCEAMN01NZQ189N Hourly earnings, manufacturing, New Zealand (NZD/hr, Q, 1989+)

source_authority='FRED' for every row (data lineage = St. Louis Fed redistribution).
For OECD-sourced international series, attribution string includes the OECD
citation per the OECD "should be cited as follows" notes field  -  surfaced in
source_url and source_series_id; full citation also pasted into the Provider
Archive doc for the loader.

Schema notes:
  wages.measure ∈ {median_hourly, mean_hourly, minimum_hourly, median_weekly,
                   mean_weekly, median_annual, mean_annual,
                   real_median_hourly, real_mean_hourly,
                   nominal_annual, real_annual}
  wages.source_authority ∈ {... 'FRED' ...}  ← already present, no schema migration needed
  wages.currency NOT NULL DEFAULT 'USD'      ← supplied per-series below
  wages has no populated_by/status/revision_number  -  simpler than inflation_rates.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-fred-wages.log"
ENV_PATH = "/opt/bb-support/.env"
SLEEP_BETWEEN = 1

# (fred_id, country_iso2, region, measure, currency, cadence, label)
SERIES = [
    # ---------- US (BLS via FRED, USD) ----------
    # region disambiguates series that share country+measure (uq_wages_key
    # = country, COALESCE(region,''), measure, period_start, source_authority)
    ("CES0500000003", "US", "total-private-all-employees",     "mean_hourly",
     "USD", "monthly",
     "Avg Hourly Earnings, All Employees, Total Private (BLS CES)"),
    ("AHETPI",        "US", "total-private-production",        "mean_hourly",
     "USD", "monthly",
     "Avg Hourly Earnings, Production & Nonsupervisory, Total Private (BLS CES)"),
    ("CES3000000008", "US", "manufacturing-production",        "mean_hourly",
     "USD", "monthly",
     "Avg Hourly Earnings, Production, Manufacturing (BLS CES, 1939+)"),
    ("CES0500000011", "US", "total-private-all-employees",     "mean_weekly",
     "USD", "monthly",
     "Avg Weekly Earnings, All Employees, Total Private (BLS CES)"),
    ("FEDMINNFRWG",   "US", "federal",                         "minimum_hourly",
     "USD", "monthly",
     "Federal Minimum Hourly Wage, Nonfarm Workers (US DOL via FRED)"),

    # ---------- International (OECD via FRED, local currency, manufacturing) ----------
    ("LCEAMN01CAM189S", "CA", "manufacturing", "mean_hourly", "CAD", "monthly",
     "Hourly Earnings, Manufacturing, Canada (OECD MEI via FRED)"),
    ("LCEAMN01SEM189N", "SE", "manufacturing", "mean_hourly", "SEK", "monthly",
     "Hourly Earnings, Manufacturing, Sweden (OECD MEI via FRED)"),
    ("LCEAMN01NZQ189N", "NZ", "manufacturing", "mean_hourly", "NZD", "quarterly",
     "Hourly Earnings, Manufacturing, New Zealand (OECD MEI via FRED)"),
]


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


def _fred_key():
    for line in open(ENV_PATH):
        if line.startswith("FRED_API_KEY="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v
    raise RuntimeError("FRED_API_KEY not in /opt/bb-support/.env")


def _signal_alert(subject, body=""):
    try:
        subprocess.run(
            ["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body],
            timeout=15,
        )
    except Exception:
        pass


def fetch_series(series_id, api_key):
    url = (f"https://api.stlouisfed.org/fred/series/observations"
           f"?series_id={series_id}&api_key={api_key}&file_type=json"
           f"&observation_start=1900-01-01")
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            log(f"  {series_id} HTTP {e.code}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  {series_id} err: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def _period_end(d, cadence):
    if cadence == "quarterly":
        m = d.month + 3
        y = d.year + (m - 1) // 12
        m = ((m - 1) % 12) + 1
        return date(y, m, 1) - timedelta(days=1)
    if d.month == 12:
        ny, nm = d.year + 1, 1
    else:
        ny, nm = d.year, d.month + 1
    return date(ny, nm, 1) - timedelta(days=1)


def _period_label(d, cadence):
    if cadence == "quarterly":
        return f"{d.year}-Q{((d.month - 1) // 3) + 1}"
    return d.strftime("%Y-%m")


def build_rows(series_id, country, region, measure, currency, cadence,
               observations, fetched_at_iso):
    rows = []
    src_url = f"https://fred.stlouisfed.org/series/{series_id}"
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
        pe = _period_end(ds, cadence)
        # wages columns (from \d wages):
        # country, region, measure, period_start, period_end, period_label,
        # release_date, value, currency, base_year, source_authority,
        # source_url, source_series_id, provenance, fetched_at, inserted_at
        rows.append([
            country,
            region or "",
            measure,
            ds.isoformat(),
            pe.isoformat(),
            _period_label(ds, cadence),
            "",                       # release_date unknown for backfill
            str(val),
            currency,
            "",                       # base_year n/a for level-form
            "FRED",
            src_url,
            series_id,
            "historical-backfill",
            fetched_at_iso,
            fetched_at_iso,
        ])
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("country, region, measure, period_start, period_end, period_label, "
            "release_date, value, currency, base_year, source_authority, "
            "source_url, source_series_id, provenance, fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_w (LIKE wages INCLUDING DEFAULTS);\n"
        f"\\copy _stg_w ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO wages ({cols}) "
        f"SELECT {cols} FROM _stg_w ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_w;\n"
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


def continuity_check_end_of_run():
    """Per-series row-count + min/max date audit; alert on absurd gaps.
    Per memory feedback_loader_continuity_checks.md."""
    try:
        series_ids = "','".join(s[0] for s in SERIES)
        sql = (
            "SELECT country, source_series_id, measure, currency, "
            "  count(*) AS n, min(period_start), max(period_start) "
            "FROM wages "
            f"WHERE source_authority='FRED' AND source_series_id IN ('{series_ids}') "
            "GROUP BY 1,2,3,4 ORDER BY 1, 2;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (FRED wages):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
        # Expect at least 6 series rows; if missing, alert
        present = sum(1 for line in (r.stdout or "").splitlines()
                      if any(s[0] in line for s in SERIES))
        if present < len(SERIES) - 1:  # tolerate at most one stale/missing
            _signal_alert(
                f"ORBI FRED wages continuity: only {present}/{len(SERIES)} series present",
                (r.stdout or "")[:600],
            )
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== Phase G FRED wages loader start ===")
    api_key = _fred_key()
    fetched_at = datetime.now(timezone.utc).isoformat()
    grand_total = 0
    for series_id, country, region, measure, currency, cadence, label in SERIES:
        log(f"[{series_id}] fetching ({label}) ...")
        d = fetch_series(series_id, api_key)
        if not d or "observations" not in d:
            log(f"[{series_id}] EMPTY  -  skipping")
            continue
        obs = d["observations"]
        log(f"[{series_id}] got {len(obs)} observations")
        rows = build_rows(series_id, country, region, measure, currency,
                          cadence, obs, fetched_at)
        n = copy_rows(rows)
        if n >= 0:
            log(f"[{series_id}] wrote {n} rows (ON CONFLICT DO NOTHING)")
            grand_total += n
        time.sleep(SLEEP_BETWEEN)
    log(f"=== done: {grand_total} candidate rows across {len(SERIES)} series ===")
    continuity_check_end_of_run()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI Phase G FRED wages FAILED", str(e)[:200])
        sys.exit(1)
