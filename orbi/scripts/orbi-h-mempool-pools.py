#!/usr/bin/env python3
"""
Phase H  -  mempool.space mining-pool concentration loader.

Endpoint: GET https://mempool.space/api/v1/mining/pools/{timeframe}
Returns: {"pools":[{poolId, name, link, blockCount, rank, emptyBlocks,
                    slug, avgMatchRate, avgFeeDelta, poolUniqueId}],
          "blockCount": int, "lastEstimatedHashrate": float, ...}

Writes per (timeframe, pool):
  - POOL_BLOCKS   value=blockCount   unit='count'
  - POOL_SHARE    value=share*100    unit='percent_share'
context: {"pool_name":..., "pool_slug":..., "pool_unique_id":...,
          "timeframe":..., "window_blocks": total}
period_start/end: today (snapshot of the trailing window)
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone, timedelta
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-pools.log"
ENDPOINT_TPL = "https://mempool.space/api/v1/mining/pools/{tf}"
TIMEFRAMES = ["1m", "1y", "3y"]
WINDOW_DAYS = {"1m": 30, "1y": 365, "3y": 1095}
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


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
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
            _signal_alert("ORBI mempool-pools COPY failed", r.stderr[:200])
            return -1
        return len(lines)
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI mempool-pools COPY exception", str(e)[:200])
        return -1


def continuity_check():
    sql = (
        "SELECT metric_kind, "
        "context_jsonb->>'timeframe' AS tf, count(*) AS n "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind IN ('POOL_BLOCKS','POOL_SHARE') "
        "GROUP BY 1,2 ORDER BY 1,2;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (mempool pools):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def main():
    log("=== Phase H mempool pools loader start ===")
    today = date.today()
    today_iso = today.isoformat()
    all_rows = []
    for tf in TIMEFRAMES:
        url = ENDPOINT_TPL.format(tf=tf)
        log(f"fetch {url}")
        data = fetch(url)
        if not data or "pools" not in data:
            log(f"  WARN: empty response for {tf}")
            _signal_alert(f"ORBI mempool-pools empty ({tf})")
            continue
        pools = data["pools"]
        total_blocks = int(data.get("blockCount") or sum(p["blockCount"] for p in pools))
        log(f"  {tf}: {len(pools)} pools, blockCount={total_blocks}")
        period_start = (today - timedelta(days=WINDOW_DAYS[tf])).isoformat()
        plabel = f"{tf} window ending {today_iso}"
        citation = f"mempool.space, /api/v1/mining/pools/{tf}, fetched {today_iso}"
        for p in pools:
            blocks = int(p.get("blockCount") or 0)
            if blocks <= 0:
                continue
            share = (blocks / total_blocks * 100.0) if total_blocks > 0 else 0.0
            ctx = json.dumps({
                "pool_name": p.get("name"),
                "pool_slug": p.get("slug"),
                "pool_unique_id": p.get("poolUniqueId"),
                "timeframe": tf,
                "window_blocks": total_blocks,
            })
            all_rows.append((
                "POOL_BLOCKS", period_start, today_iso, plabel,
                str(blocks), "count", ctx, url, citation, "historical-backfill",
            ))
            all_rows.append((
                "POOL_SHARE", period_start, today_iso, plabel,
                f"{share:.4f}", "percent_share", ctx, url, citation, "historical-backfill",
            ))
    log(f"prepared {len(all_rows)} rows")
    n = copy_rows(all_rows)
    log(f"COPY result: {n}")
    continuity_check()
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI mempool-pools FAILED", str(e)[:200])
        sys.exit(1)
