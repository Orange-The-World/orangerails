#!/usr/bin/env python3
"""
ORBI daily CB refresh — bulletproof, self-healing gap-fill.

For every active central bank in cb-refresh-config.json:
  1. Query MAX(bucket_ts) for that authority via Supabase Management API.
  2. Compute age_days vs today.
  3. If current -> skip.
  4. If gap within watchdog window -> invoke orchestrator.ts <cb> <last+1d> <today>.
  5. If gap exceeds watchdog_days -> flag STALE (deep-recovery handles big holes).
  6. Write a status JSON and emit one Signal alert if any errors or stale CBs.

Secret access: ORANGERAILS_PROD_ACCESS_TOKEN + ORANGERAILS_PROD_SUPABASE_URL
are read from os.environ. The systemd service injects them via
/opt/bb-support/scripts/with-secret.py. BANXICO_API_TOKEN and FRED_API_KEY
are also injected for the orchestrator child process.

Run modes:
  cb-daily-refresh.py                  - normal daily run
  cb-daily-refresh.py --dry-run        - status report only, no writes
  cb-daily-refresh.py --deep-recovery  - 30-day backfill across all active CBs
  cb-daily-refresh.py --only fed,ecb   - limit to a subset (debugging)
"""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]  # orangerails/
ORBI_DIR = REPO_ROOT / "orbi"
CONFIG_PATH = SCRIPT_DIR / "cb-refresh-config.json"

PID_DIR = Path("/var/run/orbi")
PID_FILE = PID_DIR / "cb-refresh.pid"
STATUS_DIR = Path("/var/log/orbi")
STATUS_FILE = STATUS_DIR / "cb-refresh-status.json"

SIGNAL_URL = "http://127.0.0.1:8090/v2/send"
FOUNDER_NUMBER = "+17057123215"
SENDER_NUMBER = "+15128818663"

DEEP_RECOVERY_DAYS = 30
ORCHESTRATOR_TIMEOUT_SEC = 600  # 10 min per CB
BUN_BIN = "/usr/local/bin/bun"


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def warn(msg: str) -> None:
    log(f"WARN: {msg}")


# ---------------------------------------------------------------------------
# Pidfile lock (prevents concurrent runs)
# ---------------------------------------------------------------------------
def acquire_lock() -> None:
    PID_DIR.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(PID_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except OSError as e:
        if e.errno == errno.EEXIST:
            # Stale lock?
            try:
                old_pid = int(PID_FILE.read_text().strip())
                os.kill(old_pid, 0)
                # Still running.
                log(f"Another run is active (pid {old_pid}); exiting.")
                sys.exit(0)
            except (ValueError, ProcessLookupError, OSError):
                warn(f"Removing stale pidfile {PID_FILE}")
                PID_FILE.unlink(missing_ok=True)
                fd = os.open(str(PID_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        else:
            raise
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()))


def release_lock() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception as e:
        warn(f"Could not remove pidfile: {e}")


# ---------------------------------------------------------------------------
# Supabase Management API
# ---------------------------------------------------------------------------
def supabase_project_ref(url: str) -> str:
    import re
    m = re.match(r"^https://([a-z0-9]{15,40})\.supabase\.(co|com)", url)
    if not m:
        raise RuntimeError("ORANGERAILS_PROD_SUPABASE_URL does not match expected pattern")
    return m.group(1)


def mgmt_query(access_token: str, project_ref: str, sql: str) -> list[dict[str, Any]]:
    res = requests.post(
        f"https://api.supabase.com/v1/projects/{project_ref}/database/query",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "ORBI-CB-Daily-Refresh/1.0",
        },
        json={"query": sql},
        timeout=30,
    )
    if res.status_code not in (200, 201):
        raise RuntimeError(f"Mgmt API {res.status_code}: {res.text[:300]}")
    data = res.json()
    if not isinstance(data, list):
        raise RuntimeError(f"Mgmt API returned non-list: {str(data)[:300]}")
    return data


# ---------------------------------------------------------------------------
# Signal alert
# ---------------------------------------------------------------------------
def signal_alert(message: str, dry_run: bool = False) -> None:
    payload = {
        "message": message,
        "number": SENDER_NUMBER,
        "recipients": [FOUNDER_NUMBER],
    }
    if dry_run:
        log("[DRY-RUN] would send Signal alert:")
        log(message)
        return
    try:
        res = requests.post(SIGNAL_URL, json=payload, timeout=10)
        if res.status_code >= 400:
            warn(f"Signal POST {res.status_code}: {res.text[:200]}")
        else:
            log("Signal alert sent.")
    except Exception as e:
        warn(f"Signal alert failed: {e}")


# ---------------------------------------------------------------------------
# Per-CB processing
# ---------------------------------------------------------------------------
def cb_db_authority(cb: str, entry: dict[str, Any]) -> str:
    return entry.get("db_authority", cb.upper())


def cb_orchestrator_key(cb: str, entry: dict[str, Any]) -> str:
    return entry.get("orchestrator_key", cb)


def fetch_last_bucket(access_token: str, project_ref: str, db_authority: str) -> dt.date | None:
    rows = mgmt_query(
        access_token,
        project_ref,
        f"SELECT MAX(bucket_ts)::text AS last_ts FROM exchange_rates "
        f"WHERE source_authority = '{db_authority}'",
    )
    if not rows:
        return None
    raw = rows[0].get("last_ts")
    if not raw:
        return None
    # bucket_ts is timestamptz; parse just the date portion.
    return dt.date.fromisoformat(raw[:10])


def run_orchestrator(orch_key: str, from_date: dt.date, to_date: dt.date) -> tuple[int, str, str, int]:
    """Run bun orchestrator. Returns (rc, stdout, stderr, rows_written)."""
    cmd = [
        BUN_BIN, "run", "scripts/central-banks/orchestrator.ts",
        orch_key, from_date.isoformat(), to_date.isoformat(),
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(ORBI_DIR),
        capture_output=True,
        text=True,
        timeout=ORCHESTRATOR_TIMEOUT_SEC,
        env=os.environ.copy(),
    )
    # Parse "written: N" line from stdout.
    rows_written = 0
    for line in proc.stdout.splitlines():
        s = line.strip()
        if s.startswith("written:"):
            try:
                rows_written = int(s.split(":", 1)[1].strip())
            except ValueError:
                pass
            break
    return proc.returncode, proc.stdout, proc.stderr, rows_written


def process_cb(
    cb: str,
    entry: dict[str, Any],
    access_token: str,
    project_ref: str,
    today: dt.date,
    deep_recovery: bool,
    dry_run: bool,
) -> dict[str, Any]:
    db_auth = cb_db_authority(cb, entry)
    orch_key = cb_orchestrator_key(cb, entry)
    watchdog = int(entry.get("watchdog_days", 5))
    status: dict[str, Any] = {
        "db_authority": db_auth,
        "orchestrator_key": orch_key,
        "watchdog_days": watchdog,
    }

    try:
        last = fetch_last_bucket(access_token, project_ref, db_auth)
    except Exception as e:
        status["result"] = "ERROR"
        status["error"] = f"MAX(bucket_ts) query failed: {str(e)[:300]}"
        return status

    if last is None:
        status["last_ts"] = None
        status["age_days"] = None
        status["result"] = "EMPTY"
        status["error"] = "no rows in exchange_rates for this authority"
        return status

    age = (today - last).days
    status["last_ts"] = last.isoformat()
    status["age_days"] = age

    if deep_recovery:
        from_date = max(last - dt.timedelta(days=DEEP_RECOVERY_DAYS), last + dt.timedelta(days=1))
        # Always re-pull the trailing window even if "current"; ON CONFLICT handles dupes.
        from_date = today - dt.timedelta(days=DEEP_RECOVERY_DAYS)
        to_date = today
    else:
        if age <= 1:
            # age=0 -> already today; age=1 -> yesterday is last, today probably
            # hasn't published yet (we run at 03:00 UTC, most CBs publish in
            # business-day afternoons). Catch today's row on the next tick.
            status["result"] = "current"
            return status
        if age > watchdog:
            status["result"] = "STALE"
            status["message"] = (
                f"Last row {last} is {age}d old (threshold {watchdog}d); deep-recovery will retry."
            )
            return status
        from_date = last + dt.timedelta(days=1)
        to_date = today
        if from_date > to_date:
            # Defensive: shouldn't happen given the age<=1 guard above.
            status["result"] = "current"
            return status

    if dry_run:
        status["result"] = "would-fill"
        status["from_date"] = from_date.isoformat()
        status["to_date"] = to_date.isoformat()
        return status

    log(f"  -> {cb}: orchestrator {orch_key} {from_date} {to_date}")
    t0 = time.time()
    try:
        rc, stdout, stderr, rows_written = run_orchestrator(orch_key, from_date, to_date)
    except subprocess.TimeoutExpired:
        status["result"] = "ERROR"
        status["error"] = f"orchestrator timed out after {ORCHESTRATOR_TIMEOUT_SEC}s"
        return status
    except Exception as e:
        status["result"] = "ERROR"
        status["error"] = f"orchestrator failed to launch: {str(e)[:300]}"
        return status

    elapsed = round(time.time() - t0, 1)
    status["elapsed_sec"] = elapsed
    status["rows_added"] = rows_written
    status["from_date"] = from_date.isoformat()
    status["to_date"] = to_date.isoformat()

    if rc == 0:
        status["result"] = "filled" if not deep_recovery else "deep-recovered"
    else:
        status["result"] = "ERROR"
        # Capture last line of stderr (orchestrator prints diagnostics there).
        tail = (stderr or stdout).strip().splitlines()
        status["error"] = (tail[-1] if tail else f"exit {rc}")[:500]
        status["exit_code"] = rc
    return status


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Report only, no writes (and no Signal alert).")
    parser.add_argument("--deep-recovery", action="store_true",
                        help=f"Force {DEEP_RECOVERY_DAYS}-day backfill for every active CB.")
    parser.add_argument("--only", default="",
                        help="Comma-separated subset of CBs to run.")
    args = parser.parse_args()

    if not CONFIG_PATH.exists():
        log(f"ERR: config not found at {CONFIG_PATH}")
        return 2
    with CONFIG_PATH.open() as f:
        config = json.load(f)

    only_set = {x.strip() for x in args.only.split(",") if x.strip()}

    access_token = os.environ.get("ORANGERAILS_PROD_ACCESS_TOKEN", "")
    supabase_url = os.environ.get("ORANGERAILS_PROD_SUPABASE_URL", "")
    if not access_token or not supabase_url:
        log("ERR: ORANGERAILS_PROD_ACCESS_TOKEN / ORANGERAILS_PROD_SUPABASE_URL not in env")
        log("     (run under /opt/bb-support/scripts/with-secret.py)")
        return 2
    project_ref = supabase_project_ref(supabase_url)

    acquire_lock()
    today = dt.datetime.now(dt.timezone.utc).date()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()

    overall: dict[str, Any] = {
        "started_at": started_at,
        "mode": "deep-recovery" if args.deep_recovery else ("dry-run" if args.dry_run else "daily"),
        "today_utc": today.isoformat(),
        "cbs": {},
        "summary": {"checked": 0, "current": 0, "filled": 0, "stale": 0, "errors": 0, "empty": 0, "skipped": 0},
    }

    try:
        for cb, entry in config.items():
            if cb.startswith("_"):
                continue
            if not entry.get("active", False):
                overall["cbs"][cb] = {"result": "inactive", "_note": entry.get("_note", "")}
                overall["summary"]["skipped"] += 1
                continue
            if only_set and cb not in only_set:
                overall["cbs"][cb] = {"result": "filtered-out"}
                overall["summary"]["skipped"] += 1
                continue
            log(f"CB {cb}: checking last bucket...")
            st = process_cb(cb, entry, access_token, project_ref, today,
                            args.deep_recovery, args.dry_run)
            overall["cbs"][cb] = st
            overall["summary"]["checked"] += 1
            res = st.get("result")
            if res == "current":
                overall["summary"]["current"] += 1
            elif res in ("filled", "deep-recovered", "would-fill"):
                overall["summary"]["filled"] += 1
            elif res == "STALE":
                overall["summary"]["stale"] += 1
            elif res == "EMPTY":
                overall["summary"]["empty"] += 1
            elif res == "ERROR":
                overall["summary"]["errors"] += 1

        overall["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()

        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        # Atomic write.
        tmp = STATUS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(overall, indent=2, sort_keys=False))
        tmp.replace(STATUS_FILE)
        log(f"Status written to {STATUS_FILE}")
        log(f"Summary: {json.dumps(overall['summary'])}")

        summary = overall["summary"]
        bad = summary["stale"] + summary["errors"] + summary["empty"]
        if bad > 0 and not args.dry_run:
            problem_cbs = []
            for cb, st in overall["cbs"].items():
                if st.get("result") in ("STALE", "ERROR", "EMPTY"):
                    line = f"  {cb} [{st.get('result')}] age={st.get('age_days')}d"
                    if st.get("error"):
                        line += f" — {st['error'][:120]}"
                    problem_cbs.append(line)
            msg = (
                f"ORBI CB daily refresh ({overall['mode']}) — {bad} problem(s):\n"
                + "\n".join(problem_cbs)
                + f"\n\nSummary: {json.dumps(summary)}\n"
                + f"Full status: {STATUS_FILE}"
            )
            signal_alert(msg)
            return 1
        return 0
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
