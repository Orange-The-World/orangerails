#!/usr/bin/env python3
"""
Phase H  -  mempool.space HASHRATE pre-2023 backfill (derived from difficulty).

Live `orbi-h-mempool-hashrate.py` pulls /api/v1/mining/hashrate/3y which only
goes back to 2023-05-30. The /difficulty-adjustments endpoint, however, returns
458+ retargets back to block 0 (genesis 2009-01-03), already loaded into
`bitcoin_network_metrics` as metric_kind='BLOCK_DIFFICULTY'.

Derivation:
    hashrate ≈ difficulty × 2^32 / 600 seconds  (per Mempool.space methodology)
    units: H/s → EH/s by dividing 1e18

One HASHRATE row is emitted per retarget (period_start = retarget date).
Rows are marked provenance='derived', source_authority='MEMPOOL_SPACE',
context_jsonb includes block_height + adjustment_index + derivation note.

One-shot historical loader. ON CONFLICT DO NOTHING  -  coexists with live weekly
loader (which writes 1097 daily HASHRATE rows from 2023-05-30 forward).
"""
import json, os, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-hashrate-backfill.log"
SRC_AUTH = "MEMPOOL_SPACE"
SRC_URL = "https://mempool.space/api/v1/mining/difficulty-adjustments"
CITATION = (
    "Derived from mempool.space /api/v1/mining/difficulty-adjustments; "
    "hashrate ≈ difficulty × 2^32 / 600. Methodology confirmed by Mempool.space."
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


def run_psql(sql, mode="-c"):
    return subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1",
         "-At", "-F", "|", mode, sql],
        capture_output=True, text=True, timeout=120,
    )


def fetch_difficulty_rows():
    """Read every BLOCK_DIFFICULTY row from bitcoin_network_metrics."""
    sql = (
        "SELECT period_start, value, context_jsonb->>'block_height', "
        "       context_jsonb->>'adjustment_index' "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind='BLOCK_DIFFICULTY' AND source_authority='MEMPOOL_SPACE' "
        "ORDER BY period_start ASC;"
    )
    r = run_psql(sql)
    if r.returncode != 0:
        log(f"FATAL: difficulty select failed: {r.stderr[:300]}")
        return []
    out = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        try:
            d, val, h, idx = line.split("|")
            out.append((d, float(val), int(h), int(idx)))
        except Exception:
            continue
    return out


def build_rows(diff_rows, cutoff_date):
    """Derive HASHRATE per retarget, only for retargets BEFORE cutoff_date
    (because the live daily HASHRATE loader covers cutoff_date onward)."""
    fetched_at = datetime.now(timezone.utc).isoformat()
    rows = []
    for d, difficulty, height, idx in diff_rows:
        if d >= cutoff_date:
            continue
        hashrate_h_s = difficulty * (2 ** 32) / 600.0
        ehs = hashrate_h_s / 1e18
        if ehs <= 0:
            continue
        ctx = json.dumps({
            "block_height": height,
            "adjustment_index": idx,
            "derivation": "difficulty * 2^32 / 600s",
            "source_metric": "BLOCK_DIFFICULTY",
        })
        rows.append([
            "HASHRATE", d, d, d,
            f"{ehs:.10g}", "EH/s",
            ctx, SRC_AUTH, SRC_URL, CITATION,
            "derived", fetched_at, fetched_at,
        ])
    return rows


def copy_rows(rows):
    if not rows:
        return 0
    lines = []
    for r in rows:
        clean = [str(v).replace("\t", " ").replace("\n", " ") for v in r]
        lines.append("\t".join(clean))
    data = "\n".join(lines) + "\n"
    cols = ("metric_kind, period_start, period_end, period_label, value, unit, "
            "context_jsonb, source_authority, source_url, citation, provenance, "
            "fetched_at, inserted_at")
    script = (
        f"CREATE TEMP TABLE _stg_bnm (LIKE bitcoin_network_metrics INCLUDING DEFAULTS);\n"
        f"\\copy _stg_bnm ({cols}) FROM STDIN\n"
        + data + "\\.\n"
        f"INSERT INTO bitcoin_network_metrics ({cols}) "
        f"SELECT {cols} FROM _stg_bnm ON CONFLICT DO NOTHING;\n"
        "DROP TABLE _stg_bnm;\n"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1"],
        input=script, capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        log(f"COPY FAIL: {r.stderr[:400]}")
        return -1
    return len(lines)


def continuity_check_end_of_run():
    try:
        sql = (
            "SELECT provenance, count(*), min(period_start), max(period_start) "
            "FROM bitcoin_network_metrics "
            "WHERE metric_kind='HASHRATE' "
            "GROUP BY 1 ORDER BY 1;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (HASHRATE by provenance):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== mempool HASHRATE pre-2023 backfill (derived from difficulty) ===")
    cutoff = "2023-05-30"  # live HASHRATE coverage starts here
    diff = fetch_difficulty_rows()
    log(f"loaded {len(diff)} BLOCK_DIFFICULTY rows")
    rows = build_rows(diff, cutoff)
    log(f"derived {len(rows)} HASHRATE rows (before {cutoff})")
    n = copy_rows(rows)
    log(f"COPY result: {n}")
    continuity_check_end_of_run()
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI mempool hashrate-backfill FAILED", str(e)[:200])
        sys.exit(1)
