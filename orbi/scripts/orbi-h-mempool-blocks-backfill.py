#!/usr/bin/env python3
"""
Phase H  -  mempool.space BLOCK_SIZE / BLOCK_TX_COUNT / BLOCK_DIFFICULTY backfill.

Live `orbi-h-mempool-blocks.py` pulls ~1000 most-recent blocks (7 days).
This one-shot walks /api/blocks/{height} backwards from MIN(existing) down to
a target floor block (default: 840000 = 2024-04-19 halving).

API: /api/blocks/{height} returns 15 blocks at and BELOW the given height.
Courtesy throttle: 1 req/sec.

Idempotent: ON CONFLICT DO NOTHING by (metric_kind, period_start, period_end,
COALESCE(context_jsonb,'{}'), source_authority).

Resumable: reads MIN(block_height) for BLOCK_SIZE each batch and continues from
there. Safe to kill + restart.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-blocks-backfill.log"
BLOCKS_TPL = "https://mempool.space/api/blocks/{h}"
SRC_AUTH = "MEMPOOL_SPACE"
PAUSE = 1.0
FLOOR_HEIGHT = int(os.environ.get("ORBI_BLOCKS_FLOOR", "840000"))
BATCH_FLUSH = 100  # COPY every N blocks accumulated


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


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                log("  rate-limited, sleep 60s")
                time.sleep(60)
            else:
                log(f"  HTTP {e.code} for {url[-60:]}")
                time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:160]}")
            time.sleep(10 * (attempt + 1))
    return None


def get_min_height():
    """Read the lowest block_height currently in BLOCK_SIZE."""
    sql = (
        "SELECT MIN((context_jsonb->>'block_height')::int) "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind='BLOCK_SIZE' AND source_authority='MEMPOOL_SPACE';"
    )
    r = subprocess.run(
        ["/opt/bb-support/scripts/psql-orange-world", "-At", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return int((r.stdout or "").strip() or 0)
    except Exception:
        return 0


def build_rows_for_block(b, fetched_at):
    """Each block produces 3 rows: BLOCK_SIZE / BLOCK_TX_COUNT / BLOCK_DIFFICULTY."""
    try:
        height = int(b["height"])
        size = int(b["size"])
        tx_count = int(b["tx_count"])
        difficulty = float(b["difficulty"])
        ts = int(b["timestamp"])
        block_hash = b.get("id", "")
    except Exception:
        return []
    d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
    ctx = json.dumps({"block_height": height, "block_hash": block_hash})
    src_url = f"https://mempool.space/api/blocks/{height}"
    cit = f"mempool.space, /api/blocks/{height}, fetched {datetime.now(timezone.utc).date().isoformat()}"
    return [
        ["BLOCK_SIZE", d, d, d, str(size), "bytes", ctx, SRC_AUTH, src_url, cit,
         "historical-backfill", fetched_at, fetched_at],
        ["BLOCK_TX_COUNT", d, d, d, str(tx_count), "count", ctx, SRC_AUTH, src_url, cit,
         "historical-backfill", fetched_at, fetched_at],
        ["BLOCK_DIFFICULTY", d, d, d, str(difficulty), "difficulty", ctx, SRC_AUTH, src_url, cit,
         "historical-backfill", fetched_at, fetched_at],
    ]


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
            "SELECT metric_kind, count(*), "
            "  min((context_jsonb->>'block_height')::int) AS min_h, "
            "  max((context_jsonb->>'block_height')::int) AS max_h, "
            "  min(period_start), max(period_start) "
            "FROM bitcoin_network_metrics "
            "WHERE metric_kind IN ('BLOCK_SIZE','BLOCK_TX_COUNT') "
            "  AND source_authority='MEMPOOL_SPACE' "
            "GROUP BY 1 ORDER BY 1;"
        )
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (BLOCK_SIZE/BLOCK_TX_COUNT):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"continuity check raised (suppressed): {e}")


def main():
    log("=== mempool blocks backfill start ===")
    fetched_at = datetime.now(timezone.utc).isoformat()
    cursor = get_min_height()
    log(f"existing MIN(block_height) = {cursor}; floor = {FLOOR_HEIGHT}")
    if cursor <= 0:
        log("no existing BLOCK_SIZE rows; aborting (run live blocks loader first)")
        return
    if cursor <= FLOOR_HEIGHT:
        log("already at or below floor; nothing to do")
        continuity_check_end_of_run()
        return

    # Start from one below current minimum
    next_h = cursor - 1
    batch = []
    total_in = 0
    total_loaded = 0
    while next_h > FLOOR_HEIGHT:
        url = BLOCKS_TPL.format(h=next_h)
        data = fetch_json(url)
        if not data or not isinstance(data, list):
            log(f"  empty/bad response at height {next_h}; abort batch")
            break
        for b in data:
            batch.extend(build_rows_for_block(b, fetched_at))
            total_in += 1
        # next_h becomes the lowest height we just received, minus 1
        try:
            heights = [int(b["height"]) for b in data]
            lowest = min(heights)
            next_h = lowest - 1
        except Exception:
            log("could not advance cursor; abort")
            break
        if total_in % BATCH_FLUSH == 0 or len(batch) >= BATCH_FLUSH * 3:
            n = copy_rows(batch)
            total_loaded += n if n > 0 else 0
            log(f"  flushed {n} rows; cursor at {next_h}; total_in={total_in}, total_loaded={total_loaded}")
            batch = []
        time.sleep(PAUSE)
    if batch:
        n = copy_rows(batch)
        total_loaded += n if n > 0 else 0
        log(f"  final flush {n} rows; total_loaded={total_loaded}")
    log(f"=== done: walked {total_in} blocks, {total_loaded} rows COPY-staged; cursor at {next_h} ===")
    continuity_check_end_of_run()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI mempool blocks-backfill FAILED", str(e)[:200])
        sys.exit(1)
