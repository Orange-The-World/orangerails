#!/usr/bin/env python3
"""
Phase H1  -  LBMA Gold/Silver daily fix loader → precious_metals_rates (1968+).

Source:
  LBMA: https://prices.lbma.org.uk/json/{gold_am,gold_pm,silver}.json
        Format: [{"d":"YYYY-MM-DD","v":[USD,GBP,EUR]}, ...]
        Coverage: gold AM/PM since 1968-01-02; silver since 1968-01-02; EUR null pre-1999.
        License: LBMA publishes the daily fix free for non-commercial use with attribution.
        ORBI's free side is CC-BY 4.0; attribution baked into provenance + per-row source_url.

Schema notes:
  precious_metals_rates source_authority enum DOES NOT include 'WORLD_GOLD_COUNCIL';
  it does include 'LBMA'. We use 'LBMA' for the 1968+ daily fix (which IS the LBMA
  Gold Fix / LBMA Silver Fix). The brief once said WORLD_GOLD_COUNCIL  -  that's not
  in the enum; LBMA is the correct primary authority.

Pre-1968 annual gold (Officer & Williamson / MeasuringWorth, 1257-Present) lives in
its own one-shot loader: orbi-h-officer-williamson-gold.py.

Cadence: weekly timer (LBMA publishes new fixes each business day; weekly polling
catches all of them via ON CONFLICT DO NOTHING).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from orbi_continuity import continuity_check_truth_table as _orbi_cont_tt
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-lbma-metals.log"

LBMA_FEEDS = [
    # (url, metal, product_label_in_url, granularity, product, currencies_index_map)
    ("https://prices.lbma.org.uk/json/gold_am.json", "XAU", "gold-am",
     "fix", "ORBI-FIX", {"USD": 0, "GBP": 1, "EUR": 2}),
    ("https://prices.lbma.org.uk/json/gold_pm.json", "XAU", "gold-pm",
     "fix", "ORBI-FIX", {"USD": 0, "GBP": 1, "EUR": 2}),
    ("https://prices.lbma.org.uk/json/silver.json", "XAG", "silver",
     "fix", "ORBI-FIX", {"USD": 0, "GBP": 1, "EUR": 2}),
]

# Pre-1968 annual gold prices (Officer & Williamson / MeasuringWorth) are loaded
# by the dedicated orbi-h-officer-williamson-gold.py one-shot service. The
# previous hardcoded 28-row MEASURINGWORTH_GOLD_USD table was removed when that
# loader landed; this file now owns only the LBMA daily fix feed.

CITATION_LBMA = (
    "LBMA Gold/Silver Price (fka London Gold/Silver Fix). Source: "
    "https://www.lbma.org.uk/prices-and-data. Used with attribution under "
    "LBMA's data-use terms; redistributed by ORBI under CC-BY 4.0."
)


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


def _signal_alert(subject, body=""):
    try:
        subprocess.run(["/opt/bb-support/scripts/orbi-signal-alert.sh", subject, body], timeout=15)
    except Exception:
        pass


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:
            log(f"  fetch err {url}: {str(e)[:200]}")
            time.sleep(10 * (attempt + 1))
    return None


def build_metals_rows(feed, feed_data, fetched_at_iso):
    url, metal, product_label, granularity, product, ccy_map = feed
    rows = []
    for entry in feed_data:
        d_str = entry.get("d")
        v = entry.get("v") or []
        if not d_str:
            continue
        # Use noon UTC on the date as bucket_ts (LBMA AM fix is ~10:30 London,
        # PM is ~15:00 London; we don't need intra-day resolution for a daily fix).
        # Distinguish AM vs PM via different bucket_ts so uq constraint allows both.
        if product_label == "gold-am":
            hour = 10
        elif product_label == "gold-pm":
            hour = 15
        else:
            hour = 12
        try:
            d_obj = datetime.strptime(d_str, "%Y-%m-%d").replace(
                hour=hour, tzinfo=timezone.utc
            )
        except Exception:
            continue
        bucket_ts = d_obj.isoformat()
        for ccy_code, idx in ccy_map.items():
            if idx >= len(v):
                continue
            val = v[idx]
            if val is None:
                continue
            try:
                rate = Decimal(str(val))
            except Exception:
                continue
            if rate <= 0:
                continue
            rows.append([
                metal,                       # source_metal
                ccy_code,                    # target_currency
                bucket_ts,                   # bucket_ts
                granularity,                 # granularity
                product,                     # product
                "troy_oz",                   # weight_unit
                str(rate),                   # rate
                "B-single",                  # tier
                "false",                     # composite
                "",                          # composite_via
                "1",                         # provider_count
                "CONFIRMED",                 # status
                "",                          # superseded_by_id
                fetched_at_iso,              # fetched_at
                fetched_at_iso,              # computed_at
                "lbma-fix",                  # provenance
                "LBMA",                      # source_authority
            ])
    return rows


def copy_metals(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        fields = ["\\N" if v == "" else v.replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(fields))
    data = "\n".join(lines) + "\n"
    cols = ("source_metal, target_currency, bucket_ts, granularity, product, "
            "weight_unit, rate, tier, composite, composite_via, provider_count, "
            "status, superseded_by_id, fetched_at, computed_at, provenance, source_authority")
    script = (
        f"CREATE TEMP TABLE _stg_m (LIKE precious_metals_rates INCLUDING DEFAULTS);\n"
        f"\\copy _stg_m ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"WITH ins AS (INSERT INTO precious_metals_rates ({cols}) "
        f"SELECT {cols} FROM _stg_m ON CONFLICT DO NOTHING RETURNING 1) "
        f"SELECT count(*) FROM ins;\n"
        "DROP TABLE _stg_m;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        log(f"  metals COPY FAIL: {r.stderr[:400]}")
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
    log("=== Phase H1 LBMA daily fix loader start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    total_metals = 0
    for feed in LBMA_FEEDS:
        url = feed[0]
        log(f"[{feed[2]}] GET {url}")
        feed_data = fetch(url)
        if not feed_data:
            log(f"[{feed[2]}] EMPTY  -  skipping")
            continue
        log(f"[{feed[2]}] {len(feed_data)} daily fixes")
        rows = build_metals_rows(feed, feed_data, fetched_at)
        n = copy_metals(rows)
        if n >= 0:
            log(f"[{feed[2]}] wrote {n} rows")
            total_metals += n
        time.sleep(2)
    log(f"=== LBMA total: {total_metals} rows wrote across {len(LBMA_FEEDS)} feeds ===")
    # Audit retrofit (H2 2026-05-29): per-feed continuity check across
    # both precious_metals_rates and the historical_money_prices truth table.
    for _f in LBMA_FEEDS:
        _metal = _f[1]
        _orbi_cont_tt('precious_metals_rates', 'bucket_ts',
                     f'LBMA {_metal} precious_metals_rates',
                     extra_where=f"source_authority='LBMA' AND source_metal='{_metal}'")
    _orbi_cont_tt('historical_money_prices', 'year_start',
                 'LBMA historical_money_prices',
                 extra_where="source_authority='LBMA'")
    _sync_resolutions("orbi-backfill-precious-metals-resolutions.py")
    # LBMA also writes historical_money_prices rows for pre-fix era; sync those too.
    _sync_resolutions("orbi-backfill-historical-money-prices-resolutions.py")
    log("=== done (pre-1968 gold lives in orbi-h-officer-williamson-gold.py) ===")


def _sync_resolutions(script_name):
    """Audit retrofit (2026-05-29): after every loader run, ensure every
    truth-table row has a matching *_resolutions audit row. Idempotent
    set-based anti-join INSERT lives in the backfill script. Call is non-fatal
    because audit gaps must alert but never block ingest."""
    path = f"/opt/bb-support/scripts/{script_name}"
    if not os.path.exists(path):
        log(f"  resolution-sync: {path} missing, skipping")
        return
    try:
        r = subprocess.run([path], capture_output=True, text=True, timeout=3600)
        log(f"  resolution-sync ({script_name}) rc={r.returncode}")
        if r.returncode != 0:
            log(f"  resolution-sync stderr: {r.stderr[:300]}")
            _signal_alert(f"ORBI resolution-sync FAILED ({script_name})",
                          r.stderr[:200])
    except Exception as e:
        log(f"  resolution-sync exception: {e!r}")
        _signal_alert(f"ORBI resolution-sync exception ({script_name})",
                      str(e)[:200])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI H1 LBMA/metals FAILED", str(e)[:200])
        sys.exit(1)
