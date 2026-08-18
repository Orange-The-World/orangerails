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
import fcntl
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
LOCK_FILE = "/var/run/orbi/cb-cross-rates.lock"

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

# Last-known set of TIER3_CROSSES targets that have no other ORBI writer.
# Used as a fallback when the DB query in derive_needs_orbi_row() fails.
_FALLBACK_NEEDS_ORBI_ROW = frozenset({
    "RUB", "UAH", "KZT", "MAD", "NGN", "DZD", "VND", "BDT", "EGP", "GHS",
    "BGN",
})


def derive_needs_orbi_row():
    """Derive at startup which TIER3_CROSSES targets need a companion ORBI row.

    For each target currency in TIER3_CROSSES, emit the companion row only
    when no other writer has supplied a recent non-composite ORBI row in
    exchange_rates. This avoids two failure modes of a hardcoded list:
      - a pair that gains another ORBI writer no longer gets a duplicate write
      - a pair that loses its only ORBI writer continues to be served

    Falls back to _FALLBACK_NEEDS_ORBI_ROW on query failure so the script
    keeps running during transient DB issues. Logs a drift warning whenever
    the derived set diverges from the fallback so the constant stays current.
    """
    tier3_targets = {target_ccy for _, _, target_ccy in TIER3_CROSSES}
    ccys = ",".join(f"'{c}'" for c in sorted(tier3_targets))
    res = q(
        "SELECT DISTINCT target_currency FROM exchange_rates "
        "WHERE source_currency='BTC' AND source_authority='ORBI' "
        "AND composite = false "
        f"AND target_currency IN ({ccys}) "
        "AND bucket_ts > NOW() - INTERVAL '2 hours'"
    )
    if res is None:
        log("WARNING: derive_needs_orbi_row query failed; using fallback constant")
        return _FALLBACK_NEEDS_ORBI_ROW
    has_writer = frozenset(line.strip() for line in res.splitlines() if line.strip())
    derived = tier3_targets - has_writer
    if derived != _FALLBACK_NEEDS_ORBI_ROW:
        added = sorted(derived - _FALLBACK_NEEDS_ORBI_ROW)
        removed = sorted(_FALLBACK_NEEDS_ORBI_ROW - derived)
        log(
            f"NEEDS_ORBI_ROW drift: added={added or 'none'} removed={removed or 'none'}"
        )
    return derived


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
        # Covers every psql session this script opens: derive_needs_orbi_row
        # DISTINCT scan, anchor SELECT, and INSERT. No per-call flag needed.
        "PGOPTIONS": "-c max_parallel_workers_per_gather=0",
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
    try:
        r = subprocess.run(["psql", "-At", "-F", "|", "-c", sql],
                           capture_output=True, text=True, timeout=timeout, env=PG)
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"psql error: {e}")
        return None
    if r.returncode != 0:
        log(f"psql err: {r.stderr.strip()[:200]}")
        return None
    return r.stdout.strip()


def fetch_btc_usd_window():
    """Fetch BTC/USD anchor buckets from the last 2 hours that have no
    cross-rate rows yet (DL-1363).

    Anti-join against ORBI-M rows: only returns bucket_ts values where no
    cross-rate has been written. In steady state this is 1-2 buckets
    (~30 rows), bounding the INSERT argv inside Linux's 128 KiB cap.
    PGOPTIONS (set in _pg_env) carries max_parallel_workers_per_gather=0
    for the whole session; no per-call SET flag is needed.

    Returns a list of (bucket_ts_str, rate) pairs, newest first.
    """
    anchor_sql = (
        "SELECT a.bucket_ts::text, a.rate::text FROM exchange_rates a "
        "WHERE a.source_currency='BTC' AND a.target_currency='USD' "
        "AND a.source_authority='ORBI' AND a.provenance='forward-fill' "
        "AND a.granularity='1m' AND a.bucket_ts > NOW() - INTERVAL '2 hours' "
        "AND NOT EXISTS ("
        "  SELECT 1 FROM exchange_rates x "
        "  WHERE x.source_currency='BTC' AND x.source_authority='ORBI-M' "
        "  AND x.bucket_ts = a.bucket_ts AND x.granularity='1m'"
        ") "
        "ORDER BY a.bucket_ts DESC"
    )
    try:
        r = subprocess.run(
            ["psql", "-At", "-F", "|", "-c", anchor_sql],
            capture_output=True, text=True, timeout=30, env=PG,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"psql error (fetch_btc_usd_window): {e}")
        return []
    if r.returncode != 0:
        log(f"psql err (fetch_btc_usd_window): {r.stderr.strip()[:200]}")
        return []
    res = r.stdout.strip()
    if not res:
        return []
    buckets = []
    for line in res.splitlines():
        line = line.strip()
        if "|" in line:
            ts, rate = line.split("|", 1)
            buckets.append((ts.strip(), float(rate.strip())))
    return buckets


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
    # DL-0784 P2: advisory lock -- prevent concurrent instances from racing on
    # uq_rates_pair_bucket_authority. Second invocation exits cleanly; the
    # first run covers the same bucket_ts.
    lock_path = Path(LOCK_FILE)
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        _lock_fh = open(lock_path, "w")  # noqa: SIM115 -- held for process lifetime
        fcntl.flock(_lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("advisory lock held by another instance; exiting (same bucket will be written)")
        sys.exit(0)
    except OSError as e:
        log(f"WARNING: could not acquire advisory lock ({e}); proceeding without lock")

    # DL-1363: fetch all BTC/USD anchor buckets in the 2hr window rather than
    # LIMIT 1. Holes from late-arriving anchors are repaired on next invocation.
    btc_usd_buckets = fetch_btc_usd_window()
    if not btc_usd_buckets:
        log("no BTC/USD anchor, aborting")
        sys.exit(1)
    log(
        f"BTC/USD anchor: {len(btc_usd_buckets)} bucket(s) in 2hr window, "
        f"latest {btc_usd_buckets[0][0]}"
    )

    needs_orbi_row = derive_needs_orbi_row()
    log(f"companion-ORBI targets: {sorted(needs_orbi_row)}")

    # Fetch the latest USD/X rate once per pair. Using the latest available
    # rate for backfilled buckets is acceptable: rates change slowly, and
    # fetching per-bucket historical rates would multiply DB round-trips by
    # the window size (~120x).
    usd_x_rates = {}
    for authority, source_ccy, target_ccy in TIER3_CROSSES:
        rate = fetch_usd_x(authority, target_ccy)
        if rate is None:
            log(f"no {authority} {source_ccy}/{target_ccy}, skipping")
        usd_x_rates[(authority, target_ccy)] = rate

    # Emit rows for every anchor bucket in the 2hr window. Each
    # (anchor_ts, pair) combination is upserted, repairing existing holes.
    rows = []
    for btc_usd_ts, btc_usd in btc_usd_buckets:
        for authority, source_ccy, target_ccy in TIER3_CROSSES:
            usd_x = usd_x_rates.get((authority, target_ccy))
            if usd_x is None:
                continue
            btc_x = btc_usd * usd_x
            composite_via = f"BTC-USD * USD-{target_ccy}-{authority}"
            rows.append(
                "('BTC', '" + target_ccy + "', '" + btc_usd_ts + "', "
                f"'1m', 'ORBI-M', {btc_x}, 'C-composite', true, "
                f"'{composite_via}', 1, 'CONFIRMED', NOW(), NOW(), 'forward-fill', '{authority}')"
            )
            # Companion ORBI row for pairs the v1-rate serving path queries by
            # source_authority='ORBI'. Only emitted for pairs that have no other
            # ORBI writer; distinct key (different source_authority), no conflict.
            if target_ccy in needs_orbi_row:
                rows.append(
                    "('BTC', '" + target_ccy + "', '" + btc_usd_ts + "', "
                    f"'1m', 'ORBI-M', {btc_x}, 'C-composite', true, "
                    f"'{composite_via}', 1, 'CONFIRMED', NOW(), NOW(), 'forward-fill', 'ORBI')"
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
        " DO NOTHING;"
    )
    try:
        r = subprocess.run(["psql", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
                           capture_output=True, text=True, timeout=120, env=PG)
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"INSERT error: {e}")
        sys.exit(1)
    if r.returncode != 0:
        log(f"INSERT failed: {r.stderr.strip()[:300]}")
        sys.exit(1)
    log(
        f"wrote {len(rows)} Tier 3 cross-rate rows "
        f"({len(btc_usd_buckets)} missing anchor bucket(s) x {len(TIER3_CROSSES)} pairs)"
    )


if __name__ == "__main__":
    main()
