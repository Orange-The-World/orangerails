#!/usr/bin/env python3
"""
Phase H  -  mempool.space recent-blocks loader.

Walks the tip backwards using `/api/blocks/{height}` which returns 15
blocks per call. We pull the most recent ~1000 blocks (~7 days of
history) and ALSO write rolling reward-stats summaries for the last
144 / 1008 / 4032 / 17280 / 144000 block windows.

Per-block rows written:
  BLOCK_SIZE        bytes
  BLOCK_TX_COUNT    count
  BLOCK_DIFFICULTY  difficulty
context: {"block_height": h, "block_hash": id}
period_start/end: block timestamp date

Reward-stats summary rows:
  MINING_REVENUE   sats   (totalReward)
  MINING_FEES      sats   (totalFee)
  MINING_TX_COUNT  count  (totalTx)
context: {"window_blocks": N, "start_height": h0, "end_height": h1}
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-blocks.log"
BLOCKS_TPL = "https://mempool.space/api/blocks/{h}"
TIP_HEIGHT = "https://mempool.space/api/blocks/tip/height"
REWARD_TPL = "https://mempool.space/api/v1/mining/reward-stats/{n}"
REWARD_WINDOWS = [144, 1008, 4032, 17280, 144000]
TARGET_BLOCKS = 1000
SRC_AUTH = "MEMPOOL_SPACE"
PAUSE = 0.5


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
                log("  rate-limited, sleep 60s"); time.sleep(60)
            else:
                log(f"  HTTP {e.code} for {url[:80]}"); time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:160]}"); time.sleep(10 * (attempt + 1))
    return None


def fetch_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ORBI/1.0"})
    try:
        return urllib.request.urlopen(req, timeout=30).read().decode().strip()
    except Exception as e:
        log(f"  text-fetch err: {e!r}")
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
            _signal_alert("ORBI mempool-blocks COPY failed", r.stderr[:200])
            return -1
        return len(lines)
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI mempool-blocks COPY exception", str(e)[:200])
        return -1


def continuity_check():
    sql = (
        "SELECT metric_kind, count(*) AS n, "
        "min(period_start) AS first, max(period_start) AS last "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind IN ('BLOCK_SIZE','BLOCK_TX_COUNT','BLOCK_DIFFICULTY',"
        "'MINING_REVENUE','MINING_FEES','MINING_TX_COUNT') "
        "GROUP BY 1 ORDER BY 1;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (mempool blocks):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def walk_blocks(tip):
    out = []
    h = tip
    while len(out) < TARGET_BLOCKS and h > 0:
        url = BLOCKS_TPL.format(h=h)
        batch = fetch_json(url)
        if not isinstance(batch, list) or not batch:
            log(f"  walk: empty batch at h={h}, stopping")
            break
        out.extend(batch)
        h = batch[-1]["height"] - 1
        time.sleep(PAUSE)
    return out[:TARGET_BLOCKS]


def main():
    log("=== Phase H mempool blocks loader start ===")
    today = date.today().isoformat()
    tip_txt = fetch_text(TIP_HEIGHT)
    if not tip_txt or not tip_txt.isdigit():
        log("FATAL: cannot read tip height")
        _signal_alert("ORBI mempool-blocks no tip")
        return
    tip = int(tip_txt)
    log(f"tip height: {tip}")

    blocks = walk_blocks(tip)
    log(f"walked {len(blocks)} blocks "
        f"(newest h={blocks[0]['height'] if blocks else '?'}, "
        f"oldest h={blocks[-1]['height'] if blocks else '?'})")
    cit = f"mempool.space, /api/blocks/<height>, fetched {today}"
    rows = []
    for b in blocks:
        try:
            h = int(b["height"])
            ts = int(b["timestamp"])
            d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
            ctx = json.dumps({"block_height": h, "block_hash": b.get("id")})
            label = f"block {h}"
            rows.append(("BLOCK_SIZE", d, d, label,
                         str(int(b["size"])), "bytes", ctx,
                         BLOCKS_TPL.format(h=h), cit, "historical-backfill"))
            rows.append(("BLOCK_TX_COUNT", d, d, label,
                         str(int(b["tx_count"])), "count", ctx,
                         BLOCKS_TPL.format(h=h), cit, "historical-backfill"))
            rows.append(("BLOCK_DIFFICULTY", d, d, label,
                         str(b["difficulty"]), "difficulty", ctx,
                         BLOCKS_TPL.format(h=h), cit, "historical-backfill"))
        except Exception as e:
            log(f"  skip block: {e!r}")

    for w in REWARD_WINDOWS:
        url = REWARD_TPL.format(n=w)
        rs = fetch_json(url)
        if not rs:
            log(f"  reward-stats {w}: empty")
            continue
        try:
            sb = int(rs["startBlock"]); eb = int(rs["endBlock"])
            tot_reward = int(rs["totalReward"])
            tot_fee = int(rs["totalFee"])
            tot_tx = int(rs["totalTx"])
        except Exception as e:
            log(f"  reward-stats {w} parse err: {e!r}")
            continue
        ctx = json.dumps({"window_blocks": w, "start_height": sb, "end_height": eb})
        rs_cit = f"mempool.space, /api/v1/mining/reward-stats/{w}, fetched {today}"
        label = f"rolling {w} blocks @ {today}"
        rows.append(("MINING_REVENUE", today, today, label,
                     str(tot_reward), "sats", ctx, url, rs_cit, "forward-fill"))
        rows.append(("MINING_FEES", today, today, label,
                     str(tot_fee), "sats", ctx, url, rs_cit, "forward-fill"))
        rows.append(("MINING_TX_COUNT", today, today, label,
                     str(tot_tx), "count", ctx, url, rs_cit, "forward-fill"))
        time.sleep(PAUSE)

    log(f"prepared {len(rows)} rows")
    n = copy_rows(rows)
    log(f"COPY result: {n}")
    continuity_check()
    log("=== done ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e!r}")
        _signal_alert("ORBI mempool-blocks FAILED", str(e)[:200])
        sys.exit(1)
