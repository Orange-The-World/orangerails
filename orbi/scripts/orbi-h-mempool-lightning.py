#!/usr/bin/env python3
"""
Phase H  -  mempool.space Lightning Network stats loader.

Endpoints:
  GET https://mempool.space/api/v1/lightning/statistics/latest
       -> {"latest": {channel_count, node_count, total_capacity,
                       tor_nodes, clearnet_nodes, unannounced_nodes,
                       avg_capacity, avg_fee_rate, med_capacity, ...}}
  GET https://mempool.space/api/v1/lightning/statistics/3y
       -> list[ {added, channel_count, total_capacity, tor_nodes,
                 clearnet_nodes, unannounced_nodes, clearnet_tor_nodes} ]
       (note: 3y series lacks node_count / med_capacity  -  only latest has them)

Writes:
  LN_CAPACITY (sats), LN_CHANNELS (count), LN_NODES (count),
  LN_TOR_NODES (count), LN_CLEARNET_NODES (count),
  LN_AVG_CAPACITY (sats), LN_MED_CAPACITY (sats)
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, date, timezone
from pathlib import Path

LOG = "/var/log/orbi/orbi-h-mempool-lightning.log"
LATEST = "https://mempool.space/api/v1/lightning/statistics/latest"
SERIES = "https://mempool.space/api/v1/lightning/statistics/3y"
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
            _signal_alert("ORBI mempool-lightning COPY failed", r.stderr[:200])
            return -1
        return len(lines)
    except Exception as e:
        log(f"  COPY exception: {e!r}")
        _signal_alert("ORBI mempool-lightning COPY exception", str(e)[:200])
        return -1


def continuity_check():
    sql = (
        "SELECT metric_kind, count(*) AS n, "
        "min(period_start) AS first, max(period_start) AS last "
        "FROM bitcoin_network_metrics "
        "WHERE metric_kind LIKE 'LN\\_%' ESCAPE '\\' "
        "GROUP BY 1 ORDER BY 1;"
    )
    try:
        r = subprocess.run(
            ["/opt/bb-support/scripts/psql-orange-world", "-q", "-c", sql],
            capture_output=True, text=True, timeout=60,
        )
        log("Continuity check (mempool LN):")
        for line in (r.stdout or "").splitlines():
            log(f"  {line}")
    except Exception as e:
        log(f"  continuity check failed: {e!r}")


def main():
    log("=== Phase H mempool Lightning loader start ===")
    today = date.today().isoformat()
    rows = []

    # 1) /latest  -  full snapshot with node_count + med_capacity
    latest_payload = fetch(LATEST)
    if latest_payload and latest_payload.get("latest"):
        L = latest_payload["latest"]
        added = (L.get("added") or "")[:10] or today
        cit = f"mempool.space, /api/v1/lightning/statistics/latest, fetched {today}"
        for mk, key, unit in [
            ("LN_CAPACITY",        "total_capacity",      "sats"),
            ("LN_CHANNELS",        "channel_count",       "count"),
            ("LN_NODES",           "node_count",          "count"),
            ("LN_TOR_NODES",       "tor_nodes",           "count"),
            ("LN_CLEARNET_NODES",  "clearnet_nodes",      "count"),
            ("LN_AVG_CAPACITY",    "avg_capacity",        "sats"),
            ("LN_MED_CAPACITY",    "med_capacity",        "sats"),
        ]:
            v = L.get(key)
            if v is None:
                continue
            rows.append((
                mk, added, added, added, str(v), unit,
                json.dumps({"snapshot": "latest"}),
                LATEST, cit, "forward-fill",
            ))
        log(f"latest snapshot: added={added} channels={L.get('channel_count')} "
            f"nodes={L.get('node_count')} capacity_sats={L.get('total_capacity')}")
    else:
        log("WARN: latest response empty")
        _signal_alert("ORBI mempool-lightning latest empty")

    # 2) /3y  -  daily series
    series = fetch(SERIES)
    if isinstance(series, list) and series:
        cit = f"mempool.space, /api/v1/lightning/statistics/3y, fetched {today}"
        log(f"series points: {len(series)} "
            f"(first ts={series[0].get('added')} last ts={series[-1].get('added')})")
        for pt in series:
            ts = pt.get("added")
            try:
                d = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
            except Exception:
                continue
            for mk, key, unit in [
                ("LN_CAPACITY",       "total_capacity",      "sats"),
                ("LN_CHANNELS",       "channel_count",       "count"),
                ("LN_TOR_NODES",      "tor_nodes",           "count"),
                ("LN_CLEARNET_NODES", "clearnet_nodes",      "count"),
            ]:
                v = pt.get(key)
                if v is None:
                    continue
                rows.append((
                    mk, d, d, d, str(v), unit,
                    "\\N", SERIES, cit, "historical-backfill",
                ))
    else:
        log("WARN: 3y series response empty")
        _signal_alert("ORBI mempool-lightning 3y empty")

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
        _signal_alert("ORBI mempool-lightning FAILED", str(e)[:200])
        sys.exit(1)
