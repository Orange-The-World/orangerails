#!/usr/bin/env python3
"""
Phase H  -  mempool.space difficulty-adjustments loader.

Endpoint: GET https://mempool.space/api/v1/mining/difficulty-adjustments
Returns: list of [time, height, difficulty, adjustment] arrays, newest first.
This is the GOLD set: 458+ retargets back to block 0 (genesis 2009-01-03).

Writes per retarget:
  - BLOCK_DIFFICULTY  (unit='difficulty', context={"block_height":N,
                       "adjustment_index":idx})
  - DIFFICULTY_ADJ    (unit='ratio',     same context)
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-difficulty.log"
ENDPOINT = "https://mempool.space/api/v1/mining/difficulty-adjustments"
SRC_AUTH = "MEMPOOL_SPACE"


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


def fetch():
    req = urllib.request.Request(ENDPOINT, headers={"User-Agent": "ORBI/1.0"})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                log("  rate-limited, sleep 60s"); time.sleep(60)
            else:
                log(f"  HTTP {e.code}"); time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:160]}"); time.sleep(10 * (attempt + 1))
    return None


def copy_rows(rows):
    if not rows:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    lines = []
    for r in rows:
        (mk, ps, pe, plabel, value, unit, ctx, surl, cit, prov) = r
        fields = [
            mk, ps, pe, plabel, str(value), unit,
            ctx if ctx else "\\N",
            SRC_AUTH, surl, cit, prov, now_iso, now_iso,
        ]
        clean = [str(v).replace("\t", " ").replace("\n", " ") for v in fields]
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
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-v", "ON_ERROR_STOP=1"],
            input=script, capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0:
            log(f"  COPY FAIL: {r.stderr[:400]}")
            _signal_alert("ORBI mempool-difficulty COPY failed", r.stderr[:200])
            return -1
        return len(lines)
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI mempool-difficulty COPY exception", str(e)[:200])
        return -1


def continuity_check():
    sql = (
        "SELECT metric_kind, count(*) AS n, "
        "min(period_start) AS first, max(period_start) AS last "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind IN ('BLOCK_DIFFICULTY','DIFFICULTY_ADJ') "
        "  AND source_url LIKE '%/difficulty-adjustments%' "
        "GROUP BY 1 ORDER BY 1;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (mempool difficulty-adjustments):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def main():
    log("=== Phase H mempool difficulty-adjustments loader start ===")
    today = date.today().isoformat()
    data = fetch()
    if not data or not isinstance(data, list):
        log("FATAL: empty or bad response")
        _signal_alert("ORBI mempool-difficulty empty response")
        return
    log(f"retargets returned: {len(data)} "
        f"(newest height={data[0][1]}, oldest height={data[-1][1]})")

    citation = f"mempool.space, /api/v1/mining/difficulty-adjustments, fetched {today}"
    rows = []
    # newest first; iterate ascending so adjustment_index ramps from 0 = genesis
    total = len(data)
    for i, entry in enumerate(reversed(data)):
        try:
            ts, height, difficulty, adjustment = entry
        except Exception:
            continue
        d = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
        ctx = json.dumps({"block_height": int(height), "adjustment_index": i})
        plabel = f"retarget #{i} @ block {height}"
        rows.append((
            "BLOCK_DIFFICULTY", d, d, plabel,
            str(difficulty), "difficulty", ctx,
            ENDPOINT, citation, "historical-backfill",
        ))
        rows.append((
            "DIFFICULTY_ADJ", d, d, plabel,
            str(adjustment), "ratio", ctx,
            ENDPOINT, citation, "historical-backfill",
        ))
    log(f"prepared {len(rows)} rows from {total} retargets")
    n = copy_rows(rows)
    log(f"COPY result: {n}")
    continuity_check()
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI mempool-difficulty FAILED", str(e)[:200])
        sys.exit(1)
