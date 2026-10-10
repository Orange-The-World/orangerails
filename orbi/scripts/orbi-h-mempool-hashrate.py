#!/usr/bin/env python3
"""
Phase H  -  mempool.space hashrate loader.

Endpoint: GET https://mempool.space/api/v1/mining/hashrate/3y
Returns: {
  "hashrates":  [{"timestamp": <unix>, "avgHashrate": <H/s>}, ...],  # daily
  "difficulty": [{"time": <unix>, "height": int, "difficulty": float,
                  "adjustment": float}, ...],                         # retargets
  "currentHashrate":  <H/s>,
  "currentDifficulty": <raw>
}

We write to `bitcoin_network_metrics`:
  - HASHRATE rows: daily, unit='EH/s' (avgHashrate scaled 1e-18)
  - One DIFFICULTY snapshot for currentDifficulty (latest), and a
    BLOCK_DIFFICULTY/DIFFICULTY_ADJ row per retarget seen in this envelope.

For the long-arc history (genesis → now), the difficulty loader
(orbi-h-mempool-difficulty.py) is the authoritative source  -  it hits
the `/difficulty-adjustments` endpoint which returns 458 retargets back
to block 0. This loader handles daily hashrate + current snapshots.

Posture: mempool.space public REST (AGPLv3 ethos, no surfaced restrictions,
Phase F ToS deep-dive). Brittleness-safe: try/except wraps, no re-raise
on Signal failure.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from decimal import Decimal
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-hashrate.log"
ENDPOINT = "https://mempool.space/api/v1/mining/hashrate/3y"
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
                log(f"  rate-limited, sleep 60s")
                time.sleep(60)
            else:
                log(f"  HTTP {e.code}")
                time.sleep(10 * (attempt + 1))
        except Exception as e:
            log(f"  err: {str(e)[:160]}")
            time.sleep(10 * (attempt + 1))
    return None


def copy_rows(rows):
    """rows: list of tuples
       (metric_kind, period_start, period_end, period_label, value, unit,
        context_json_str_or_NULL, source_url, citation, provenance)
    """
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
            _signal_alert("ORBI mempool-hashrate COPY failed", r.stderr[:200])
            return -1
        return len(lines)
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI mempool-hashrate COPY exception", str(e)[:200])
        return -1


def continuity_check():
    sql = (
        "SELECT metric_kind, count(*) AS n, "
        "min(period_start) AS first, max(period_start) AS last "
        "FROM bitcoin_network_metrics "
        "WHERE source_url LIKE '%/mining/hashrate%' OR metric_kind='HASHRATE' "
        "GROUP BY 1 ORDER BY 1;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (mempool hashrate):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def main():
    log("=== Phase H mempool hashrate loader start ===")
    today = date.today().isoformat()
    data = fetch()
    if not data:
        log("FATAL: empty response")
        _signal_alert("ORBI mempool-hashrate empty response")
        return
    log(f"hashrates={len(data.get('hashrates',[]))} "
        f"diff_retargets_in_window={len(data.get('difficulty',[]))} "
        f"currentHashrate={data.get('currentHashrate')} "
        f"currentDifficulty={data.get('currentDifficulty')}")

    citation = (
        f"mempool.space, /api/v1/mining/hashrate/3y, fetched {today}"
    )
    rows = []

    # 1) Daily HASHRATE series (avgHashrate is H/s; convert to EH/s)
    for h in data.get("hashrates", []):
        try:
            ts = int(h["timestamp"])
            ehs = float(h["avgHashrate"]) / 1e18
        except Exception:
            continue
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        rows.append((
            "HASHRATE", d, d, d, f"{ehs:.6f}", "EH/s",
            "\\N", ENDPOINT, citation, "historical-backfill",
        ))

    # 2) Current-snapshot rows
    current_hashrate_ehs = float(data.get("currentHashrate") or 0) / 1e18
    current_difficulty = data.get("currentDifficulty")
    if current_hashrate_ehs > 0:
        rows.append((
            "HASHRATE", today, today, f"{today} current",
            f"{current_hashrate_ehs:.6f}", "EH/s",
            json.dumps({"snapshot": "current"}),
            ENDPOINT, citation, "forward-fill",
        ))
    if current_difficulty:
        rows.append((
            "DIFFICULTY", today, today, f"{today} current",
            str(current_difficulty), "difficulty",
            json.dumps({"snapshot": "current"}),
            ENDPOINT, citation, "forward-fill",
        ))

    # 3) Difficulty-adjustment retargets that fall inside this 3y envelope
    #    (the dedicated difficulty loader covers full genesis→now; this is
    #    a convenience snapshot subset.)
    for r in data.get("difficulty", []):
        try:
            ts = int(r["time"])
            height = int(r["height"])
            diff = r["difficulty"]
            adj = r["adjustment"]
        except Exception:
            continue
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        ctx = json.dumps({"block_height": height})
        rows.append((
            "DIFFICULTY", d, d, d, str(diff), "difficulty",
            ctx, ENDPOINT, citation, "historical-backfill",
        ))
        rows.append((
            "DIFFICULTY_ADJ", d, d, d, str(adj), "ratio",
            ctx, ENDPOINT, citation, "historical-backfill",
        ))

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
        _signal_alert("ORBI mempool-hashrate FAILED", str(e)[:200])
        sys.exit(1)
