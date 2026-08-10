#!/usr/bin/env python3
"""ORBI Tier 3 BTC/X cross-rate composite.

For each CB-sourced (or OXR-sourced) USD/X rate, compute
BTC/X = BTC/USD * USD/X each minute so the live composite covers
these Tier 3/4 currencies at minute granularity.

Tagged composite_via='BTC-USD * USD-X-<AUTHORITY>' so the provenance is
unambiguous: derived from the BTC/USD spot composite times the latest
USD/X rate from the named authority. The emitted row's source_authority
mirrors the underlying USD/X authority (CBR, NBU, ..., OXR, BOC, FED)
so the synthetic does NOT collide with the forward-fill direct VW-median
row (which lives under source_authority='ORBI'). This lets consumers
choose direct vs synthetic for pairs that have both (CAD, CHF, ...).
"""
import os
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = os.environ.get("ORBI_ENV_FILE")
if not ENV_FILE:
    sys.exit("ORBI_ENV_FILE is not set. The service unit must supply it.")
LOG = os.environ.get("ORBI_CROSS_RATES_LOG", "/var/log/orbi/cb-cross-rates.log")

# (authority, source_ccy, target_ccy) tuples we compute crosses for.
# The emitted BTC/X row's source_authority = this same authority.
TIER3_CROSSES = [
    # CB-sourced (Tier 3)
    ("CBR", "USD", "RUB"),
    ("NBU", "USD", "UAH"),
    ("NBK", "USD", "KZT"),
    ("BAM", "USD", "MAD"),
    ("CBN", "USD", "NGN"),
    ("BANK_OF_ALGERIA", "USD", "DZD"),
    ("SBV", "USD", "VND"),
    ("BB", "USD", "BDT"),
    ("CBE", "USD", "EGP"),
    ("BOG", "USD", "GHS"),
    # SBP/PKR and CBK/KES scrapers shipped 2026-06-06 but egress-blocked from
    # this host; once the upstream WAFs whitelist us, uncomment:
    #   ("SBP", "USD", "PKR"),
    #   ("CBK", "USD", "KES"),
    # OXR-sourced (Tier 4, OXR-only currencies). Added 2026-06-07.
    ("OXR", "USD", "KES"),
    ("OXR", "USD", "TWD"),
    ("OXR", "USD", "PKR"),
    ("OXR", "USD", "BGN"),
    ("OXR", "USD", "JMD"),
    ("OXR", "USD", "KWD"),
    ("OXR", "USD", "LBP"),
    # Synthetic fallbacks for pairs that already have a direct ORBI
    # VW-median row from forward-fill, written under the CB authority so
    # they coexist with the direct row (different source_authority).
    # Added 2026-06-07.
    ("BOC", "USD", "CAD"),
    ("FED", "USD", "CHF"),
]


def _load_local_dsn():
    for line in open(ENV_FILE):
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


def q(sql, timeout=30):
    r = subprocess.run(["psql", "-At", "-F", "|", "-c", sql],
                       capture_output=True, text=True, timeout=timeout, env=PG)
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip()


def fetch_btc_usd():
    res = q(
        "SELECT bucket_ts::text, rate::text FROM exchange_rates "
        "WHERE source_currency='BTC' AND target_currency='USD' "
        "AND source_authority='ORBI' AND provenance='forward-fill' "
        "AND granularity='1m' ORDER BY bucket_ts DESC LIMIT 1"
    )
    if not res:
        return None, None
    parts = res.split("|")
    return parts[0], float(parts[1])


def fetch_usd_x(authority, target):
    """Latest USD/<target> from the given authority."""
    res = q(
        f"SELECT rate::text FROM exchange_rates "
        f"WHERE source_currency='USD' AND target_currency='{target}' "
        f"AND source_authority='{authority}' "
        "ORDER BY bucket_ts DESC LIMIT 1"
    )
    if not res:
        return None
    return float(res)


def main():
    btc_usd_ts, btc_usd = fetch_btc_usd()
    if btc_usd is None:
        log("no BTC/USD anchor, aborting")
        sys.exit(1)

    rows = []
    for authority, source_ccy, target_ccy in TIER3_CROSSES:
        usd_x = fetch_usd_x(authority, target_ccy)
        if usd_x is None:
            log(f"no {authority} {source_ccy}/{target_ccy}, skipping")
            continue
        btc_x = btc_usd * usd_x
        composite_via = f"BTC-USD * USD-{target_ccy}-{authority}"
        rows.append(
            "('BTC', '" + target_ccy + "', '" + btc_usd_ts + "', "
            f"'1m', 'ORBI-M', {btc_x}, 'C-composite', true, "
            f"'{composite_via}', 1, 'CONFIRMED', NOW(), NOW(), 'forward-fill', '{authority}')"
        )

    if not rows:
        log("no cross-rate rows to write")
        sys.exit(0)

    sql = (
        "INSERT INTO exchange_rates "
        "(source_currency, target_currency, bucket_ts, granularity, product, rate, "
        " tier, composite, composite_via, provider_count, status, fetched_at, computed_at, "
        " provenance, source_authority) VALUES\n" +
        ",\n".join(rows) +
        " ON CONFLICT (source_currency, target_currency, bucket_ts, source_authority, granularity, product) "
        " DO UPDATE SET rate = EXCLUDED.rate, composite_via = EXCLUDED.composite_via, "
        " computed_at = EXCLUDED.computed_at;"
    )
    r = subprocess.run(["psql", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, timeout=30, env=PG)
    if r.returncode != 0:
        log(f"INSERT failed: {r.stderr.strip()[:300]}")
        sys.exit(1)
    log(f"wrote {len(rows)} Tier 3 cross-rate rows")


if __name__ == "__main__":
    main()
