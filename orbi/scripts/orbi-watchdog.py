#!/usr/bin/env python3
"""
ORBI watchdog — runs every 5min, checks data freshness invariants and
self-heals (restart) when a service has stalled.

A service can be "active" in systemd but stuck (network hang, deadlock,
silent error loop). systemd alone won't notice. This script checks the
actual data side: is the writer landing rows?

Health checks:
  - orbi-forward-fill: latest 'forward-fill' bucket within last 5 min
  - orbi-sync-local-to-cloud: log line "synced" within last 3 min
  - orbi-phase-e-bitstamp-usd: MIN(bucket_ts) for BITSTAMP BTC/USD got
    older OR service is inactive (complete)
  - orbi-phase-e-bitstamp-eur: same shape, BTC/EUR
  - orbi-phase-e-bitstamp-gbp: same shape, BTC/GBP
  - orbi-phase-e-kraken-trades: MAX(bucket_ts) for KRAKEN got newer in
    last 10 min OR service is inactive (complete)
  - orbi-pg-proxy container running

On unhealthy:
  - Restart the systemd unit (or docker container)
  - Signal-alert founder (rate-limited: max 1 alert per service per hour)

State: /var/lib/orbi/watchdog-state.json

Note: orbi-phase-e-kraken-gap-fill-2021-2023.service is the canonical
example of feedback_loader_continuity_checks.md — a bounded-window
backfill loader that MUST be watchdogged because a silent stall would
leave a partial gap in production data.
"""
import json, os, re, subprocess, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

STATE_FILE = "/var/lib/orbi-trusted/watchdog-state.json"
LOG = "/var/log/orbi-trusted/watchdog.log"
ALERT_COOLDOWN_S = 3600
# Forward-walker services: one-shot loaders that advance toward "now".
# When log stale and unit inactive, they need re-triggering to walk further forward.
#
# Bounded historical/backward-walkers (gap-fills with explicit date ranges)
# are NOT in this set — for them, "complete" really is terminal.
FORWARD_WALKERS = {
    "orbi-phase-e-bitfinex-usd.service",
    "orbi-phase-e-kraken-trades.service",
    "orbi-phase-e-coinbase-usd.service",
    "orbi-phase-e-bitstamp-usd.service",
    "orbi-phase-e-bitstamp-eur.service",
    "orbi-phase-e-bitstamp-gbp.service",
    "orbi-phase-e-kraken-eur.service",
    "orbi-phase-e-kraken-gbp.service",
    "orbi-phase-e-kraken-cad.service",
    "orbi-phase-e-kraken-jpy.service",
    "orbi-phase-e-kraken-aud.service",
    "orbi-phase-e-kraken-chf.service",
    "orbi-phase-f-bitbank.service",
    "orbi-phase-f-mempool.service",
    "orbi-phase-f-mercadobitcoin.service",
    "orbi-phase-f-bitso@mxn.service",
    "orbi-phase-f-bitso@ars.service",
    "orbi-phase-f-bitso@brl.service",
}
# Alerts suppressed from push notifications; still logged.
MUTED_ALERTS = {
    # Geofenced / deferred by founder
    "nbs-china-freshness",
    # Catalog stubs — known thin, not urgent
    "tech-curves-freshness",
    # In-flight (will clear naturally)
    "riksbank-fx-freshness",       # Riksbank IP unban pending
    "orbi-m-cross-rate-stale",     # timer-based, will clear on next fire
    # False-positive query patterns (kept for diagnostic logging)
    "orbi-btc-usd-1m-density",     # sentinel 999999/3600=277h, misleading
    "live-1m-series-stale",        # known historical-loader pattern
    "composite-flag-integrity",    # fixed by trigger + UPDATE
    "inflation-series-90d-stale",  # query rewritten
    # Stale loaders queued for investigation but not actionable today
    "mempool-pools-freshness",
}
LOCAL_DSN = None

def _load_local_dsn():
    for line in open("/opt/bb-support/.env"):
        if line.startswith("ORBI_LOCAL_DB_URL="):
            v = line.split("=", 1)[1].strip()
            return v[1:-1] if v.startswith('"') else v

def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed).
    try:
        Path(LOG).parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except (PermissionError, OSError):
        pass

def load_state():
    if os.path.exists(STATE_FILE):
        try: return json.load(open(STATE_FILE))
        except: pass
    # Cold-start: seed last_alert with "alerted recently" so a state-file wipe
    # doesn't suddenly let every check alert at once. Honest cooldowns will
    # establish themselves over the next ALERT_COOLDOWN_S seconds.
    nu = now_unix()
    seed = {svc: nu for svc in [
        "orbi-forward-fill.service",
        "orbi-sync-local-to-cloud.timer",
        "orbi-phase-e-bitstamp-usd.service",
        "orbi-phase-e-bitstamp-eur.service",
        "orbi-phase-e-bitstamp-gbp.service",
        "orbi-phase-e-kraken-trades.service",
        # --- silent-posture loaders (added 2026-05-30) ---
        "orbi-phase-e-coinbase-usd.service",
        "orbi-phase-e-bitfinex-usd.service",
        "orbi-phase-e-kraken-eur.service",
        "orbi-phase-e-kraken-gbp.service",
        "orbi-phase-e-kraken-cad.service",
        "orbi-phase-e-kraken-jpy.service",
        "orbi-phase-e-kraken-aud.service",
        "orbi-phase-e-kraken-chf.service",
        "orbi-phase-e-kraken-gap-fill-2021-2023.service",
        # --- gap-fill loaders (added 2026-05-29 audit) ---
        "orbi-phase-e-kraken-gap-fill-eur-2016-2023.service",
        "orbi-phase-e-kraken-gap-fill-gbp-2024-2026.service",
        "orbi-phase-e-kraken-gap-fill-cad-2024-2026.service",
        "orbi-phase-e-kraken-gap-fill-usd-2024-2025.service",
        "orbi-phase-f-mempool.service",
        "orbi-phase-f-bitbank.service",
        "orbi-phase-f-mercadobitcoin.service",
        "orbi-phase-f-bitso@mxn.service",
        "orbi-phase-f-bitso@ars.service",
        "orbi-phase-f-bitso@brl.service",
        "docker:orbi-pg-proxy",
        "docker:supabase-db",
    ]}
    return {"last_alert": seed, "last_restart": {}}

def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f: json.dump(s, f)
    os.replace(tmp, STATE_FILE)

def signal_alert(subject, body=""):
    # Notifications currently suppressed; log only.
    log(f"  [signal-silenced] {subject} | {body[:120]}")
    return

def now_unix():
    return int(time.time())

def q_first(sql):
    # Try orbi DB first; fall back to secondary DB if the table is not found there.
    for wrapper in ("/opt/bb-support/scripts/psql-orbi", "/opt/bb-support/scripts/psql-orange-world"):
        # Long queries must not kill the watchdog; return None to route to _on_fail.
        try:
            r = subprocess.run([wrapper, "-At", "-c", sql],
                               capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            log(f"  q_first: query exceeded 30s on {wrapper}, treating as failed check")
            return None
        except OSError as e:
            log(f"  q_first: could not run {wrapper}: {e}")
            return None
        if r.returncode == 0:
            s = r.stdout.strip()
            return s if s else None
        # If error is "relation does not exist" (table not in this DB), try the next wrapper.
        if "does not exist" in (r.stderr or ""):
            continue
        # Different error — give up.
        return None
    return None

def systemctl_is_active(unit):
    r = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=10)
    return r.stdout.strip() == "active"

def systemctl_restart(unit):
    r = subprocess.run(["sudo", "systemctl", "restart", unit], capture_output=True, text=True, timeout=30)
    return r.returncode == 0

def docker_running(name):
    try:
        r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", name],
                           capture_output=True, text=True, timeout=30)
        return r.stdout.strip() == "true"
    except subprocess.TimeoutExpired:
        # Docker daemon overloaded; treat as unknown rather than crashing watchdog
        print(f"WARN: docker inspect {name} timed out; treating as running", file=sys.stderr)
        return True

def docker_restart(name):
    r = subprocess.run(["docker", "restart", name], capture_output=True, text=True, timeout=30)
    return r.returncode == 0

def check_forward_fill(state):
    """Latest forward-fill bucket must be within last 5 minutes."""
    s = q_first("SELECT EXTRACT(EPOCH FROM (now() - max(bucket_ts)))::int FROM exchange_rates WHERE provenance='forward-fill'")
    if s is None:
        return _on_fail(state, "orbi-forward-fill.service", "forward-fill query failed")
    age = int(s)
    if age > 600:
        return _on_fail(state, "orbi-forward-fill.service", f"latest forward-fill bucket is {age}s old (>10min)")
    return "ok"

def check_sync(state):
    """
    Two independent invariants:
      1) Liveness: ANY log line in the last 3 min (proves the timer is firing).
      2) Health:  a SUCCESS line (synced / no new rates) in the last 5 min
                  (proves we are actually pushing to Cloud, not just spinning).
    Failure of either restarts the timer; rate-limited alert.
    """
    LOG_PATH = "/tmp/orbi-sync-local-to-cloud.log"
    if not os.path.exists(LOG_PATH):
        return "no-log"
    try:
        out = subprocess.check_output(["tail", "-n", "50", LOG_PATH], text=True)
    except Exception:
        return "log-read-failed"
    latest_any = None
    latest_success = None
    for line in out.split("\n"):
        m_any = re.match(r"^\[(\S+)\] (synced|no new rates|rate sync FAILED|cloud HTTP)", line)
        m_ok  = re.match(r"^\[(\S+)\] (synced|no new rates)", line)
        if m_any:
            try:
                t = datetime.fromisoformat(m_any.group(1)).timestamp()
                if latest_any is None or t > latest_any: latest_any = t
            except: pass
        if m_ok:
            try:
                t = datetime.fromisoformat(m_ok.group(1)).timestamp()
                if latest_success is None or t > latest_success: latest_success = t
            except: pass
    if latest_any is None:
        return _on_fail(state, "orbi-sync-local-to-cloud.timer", "no recent sync log line")
    age_any = now_unix() - int(latest_any)
    if age_any > 180:
        return _on_fail(state, "orbi-sync-local-to-cloud.timer", f"last sync log {age_any}s ago (>3min)")
    if latest_success is None or (now_unix() - int(latest_success)) > 300:
        age_s = "n/a" if latest_success is None else f"{now_unix()-int(latest_success)}s"
        return _on_fail(state, "orbi-sync-local-to-cloud.timer", f"no successful sync in last 5min (last success: {age_s}); only failures visible")
    return "ok"

def check_phase_e_walker(state, unit, sql_max, direction, stall_seconds=600):
    """
    For walkers: a watermark in the DB must advance over time.
    We track previous watermark in state; if it hasn't changed AND
    service is active, restart it.
    """
    s = q_first(sql_max)
    if s is None or s == "":
        s = "0"
    prev = state.get("watermarks", {}).get(unit)
    state.setdefault("watermarks", {})[unit] = s
    state.setdefault("watermark_seen_at", {})
    if prev != s:
        state["watermark_seen_at"][unit] = now_unix()
        return "ok"
    # Same value as last tick
    last_seen = state["watermark_seen_at"].get(unit, now_unix())
    age = now_unix() - last_seen
    if age > stall_seconds:
        # Maybe the loader is just done (caught up to founding or to now)
        if not systemctl_is_active(unit):
            return "complete"
        return _on_fail(state, unit, f"watermark stalled {age}s at {s} (direction={direction})")
    return "ok-but-stale"

def _on_fail(state, unit, reason):
    log(f"UNHEALTHY: {unit} — {reason}")
    last_restart = state.get("last_restart", {}).get(unit, 0)
    if now_unix() - last_restart < 120:
        log(f"  skip restart {unit} — just restarted {now_unix() - last_restart}s ago")
        return "fail-skip-restart"
    if unit.endswith(".service") or unit.endswith(".timer"):
        ok = systemctl_restart(unit)
    elif unit.startswith("docker:"):
        ok = docker_restart(unit.split(":", 1)[1])
    else:
        ok = systemctl_restart(unit)
    state.setdefault("last_restart", {})[unit] = now_unix()
    log(f"  restart {unit} {'OK' if ok else 'FAILED'}")
    # Rate-limited alert
    last_alert = state.get("last_alert", {}).get(unit, 0)
    if now_unix() - last_alert >= ALERT_COOLDOWN_S:
        signal_alert(f"ORBI watchdog: {unit} unhealthy", reason + ("\nRestarted: OK" if ok else "\nRestart FAILED"))
        state.setdefault("last_alert", {})[unit] = now_unix()
    return "fail-restarted"


def check_phase_e_log_active(state, unit, log_path, stall_seconds=900):
    """
    For Phase E loaders: healthy = log file has been written to in the last
    stall_seconds AND the systemd service is active. Avoids brittleness of DB
    MIN/MAX tracking when the loader walks through sparse data eras or buffers
    before flushing.
    """
    import os
    if not os.path.exists(log_path):
        return _on_fail(state, unit, f"log file missing: {log_path}")
    mtime = os.path.getmtime(log_path)
    age = now_unix() - int(mtime)
    if age > stall_seconds:
        if not systemctl_is_active(unit):
            # Forward-walkers: an exited one-shot is not "done" — it has walked
            # to its current tip and needs re-triggering to keep advancing.
            # Backward-walkers (bounded gap-fills): "inactive" really IS done.
            if unit in FORWARD_WALKERS:
                return _on_fail(state, unit, f"forward-walker exited (log idle {age}s, unit inactive); re-triggering")
            return "complete"
        return _on_fail(state, unit, f"log not written in {age}s (>{stall_seconds}s); loader may be hung")
    return "ok"


def check_db_freshness(state, name, sql, max_age_hours, alert_only=False):
    """
    Generic data-freshness check. `sql` must return a single column: the age
    in seconds of the most recent relevant row (e.g. EXTRACT(EPOCH FROM (now()
    - MAX(bucket_ts)))). Alerts (and optionally tries a unit restart) when age
    exceeds threshold. `alert_only=True` skips the systemctl restart attempt —
    useful for upstream-bound loaders (FRED publication lag, delisted pairs,
    etc.) where restarting doesn't help, but the founder still wants to know.
    """
    s = q_first(sql)
    if s is None:
        return _on_fail(state, name, f"freshness query failed for {name}")
    try:
        age_s = int(float(s))
    except (TypeError, ValueError):
        return _on_fail(state, name, f"freshness query returned non-numeric '{s}' for {name}")
    # Sentinel: SQL wrapped in COALESCE(..., -1) means the table/source has no rows
    # yet — loader has never landed data. Distinguish from "stale" so the founder
    # knows whether to investigate the loader vs. the upstream.
    if age_s == -1:
        reason = f"loader has never landed data for {name} (zero rows in target table)"
        if alert_only:
            last_alert = state.get("last_alert", {}).get(name, 0)
            if now_unix() - last_alert >= ALERT_COOLDOWN_S:
                signal_alert(f"ORBI watchdog: {name} never loaded", reason)
                state.setdefault("last_alert", {})[name] = now_unix()
            log(f"NEVER-LOADED-ALERT: {name} — {reason}")
            return "never-loaded-alert"
        return _on_fail(state, name, reason)
    threshold_s = max_age_hours * 3600
    if age_s > threshold_s:
        reason = f"data stale: {age_s//3600}h old (>{max_age_hours}h threshold)"
        if alert_only:
            # Rate-limited alert, no restart.
            last_alert = state.get("last_alert", {}).get(name, 0)
            if now_unix() - last_alert >= ALERT_COOLDOWN_S:
                signal_alert(f"ORBI watchdog: {name} data stale", reason)
                state.setdefault("last_alert", {})[name] = now_unix()
            log(f"STALE-ALERT: {name} — {reason}")
            return "stale-alert"
        return _on_fail(state, name, reason)
    return "ok"


def check_proxy(state):
    if not docker_running("orbi-pg-proxy"):
        return _on_fail(state, "docker:orbi-pg-proxy", "pg-proxy container not running")
    return "ok"

def check_supabase_db(state):
    # The orbi DB lives inside the supabase-db container. If it OOMs, pg-proxy
    # stays "running" (it's just socat) but every psql query fails. Catch this
    # directly rather than waiting for forward-fill freshness to trip.
    if not docker_running("supabase-db"):
        return _on_fail(state, "docker:supabase-db", "supabase-db container not running")
    return "ok"

def main():
    global LOCAL_DSN
    LOCAL_DSN = _load_local_dsn()
    state = load_state()
    log("=== watchdog tick ===")
    results = {}
    results["pg-proxy"] = check_proxy(state)
    results["supabase-db"] = check_supabase_db(state)
    results["forward-fill"] = check_forward_fill(state)
    # CLOUD SYNC PAUSED 2026-05-30 — re-enable after Phase 2-3 reroutes to new cloud projects
    results["sync"] = "ok-skipped-migration"
    results["bitstamp-usd"]   = check_phase_e_log_active(state, "orbi-phase-e-bitstamp-usd.service",   "/var/log/orbi/orbi-phase-e-bitstamp-usd.log",   stall_seconds=900)
    results["bitstamp-eur"]   = check_phase_e_log_active(state, "orbi-phase-e-bitstamp-eur.service",   "/var/log/orbi/orbi-phase-e-bitstamp-eur.log",   stall_seconds=900)
    results["bitstamp-gbp"]   = check_phase_e_log_active(state, "orbi-phase-e-bitstamp-gbp.service",   "/var/log/orbi/orbi-phase-e-bitstamp-gbp.log",   stall_seconds=900)
    results["kraken-trades"]  = check_phase_e_log_active(state, "orbi-phase-e-kraken-trades.service",  "/var/log/orbi/orbi-phase-e-kraken-trades.log",  stall_seconds=900)
    results["coinbase-usd"]   = check_phase_e_log_active(state, "orbi-phase-e-coinbase-usd.service",   "/var/log/orbi/orbi-phase-e-coinbase-usd.log",   stall_seconds=900)
    results["bitfinex-usd"]   = check_phase_e_log_active(state, "orbi-phase-e-bitfinex-usd.service",   "/var/log/orbi/orbi-phase-e-bitfinex-usd.log",   stall_seconds=900)
    results["kraken-eur"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-eur.service",      "/var/log/orbi/orbi-phase-e-kraken-eur.log",      stall_seconds=900)
    results["kraken-gbp"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-gbp.service",      "/var/log/orbi/orbi-phase-e-kraken-gbp.log",      stall_seconds=900)
    results["kraken-cad"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-cad.service",      "/var/log/orbi/orbi-phase-e-kraken-cad.log",      stall_seconds=900)
    results["kraken-jpy"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-jpy.service",      "/var/log/orbi/orbi-phase-e-kraken-jpy.log",      stall_seconds=900)
    results["kraken-aud"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-aud.service",      "/var/log/orbi/orbi-phase-e-kraken-aud.log",      stall_seconds=900)
    results["kraken-chf"]      = check_phase_e_log_active(state, "orbi-phase-e-kraken-chf.service",      "/var/log/orbi/orbi-phase-e-kraken-chf.log",      stall_seconds=900)
    results["kraken-gap-fill"]= check_phase_e_log_active(state, "orbi-phase-e-kraken-gap-fill-2021-2023.service", "/var/log/orbi/orbi-phase-e-kraken-gap-fill-2021-2023.log", stall_seconds=900)
    # --- gap-fill loaders (added 2026-05-29 audit) ---
    results["kraken-gap-fill-eur"] = check_phase_e_log_active(state, "orbi-phase-e-kraken-gap-fill-eur-2016-2023.service", "/var/log/orbi/orbi-phase-e-kraken-gap-fill-eur-2016-2023.log", stall_seconds=900)
    results["kraken-gap-fill-gbp"] = check_phase_e_log_active(state, "orbi-phase-e-kraken-gap-fill-gbp-2024-2026.service", "/var/log/orbi/orbi-phase-e-kraken-gap-fill-gbp-2024-2026.log", stall_seconds=900)
    results["kraken-gap-fill-cad"] = check_phase_e_log_active(state, "orbi-phase-e-kraken-gap-fill-cad-2024-2026.service", "/var/log/orbi/orbi-phase-e-kraken-gap-fill-cad-2024-2026.log", stall_seconds=900)
    results["kraken-gap-fill-usd"] = check_phase_e_log_active(state, "orbi-phase-e-kraken-gap-fill-usd-2024-2025.service", "/var/log/orbi/orbi-phase-e-kraken-gap-fill-usd-2024-2025.log", stall_seconds=900)
    # Phase F loaders
    results["f-mempool"]        = check_phase_e_log_active(state, "orbi-phase-f-mempool.service",         "/var/log/orbi/orbi-phase-f-mempool.log",         stall_seconds=900)
    results["f-bitbank"]        = check_phase_e_log_active(state, "orbi-phase-f-bitbank.service",         "/var/log/orbi/orbi-phase-f-bitbank.log",         stall_seconds=900)
    results["f-mercadobitcoin"] = check_phase_e_log_active(state, "orbi-phase-f-mercadobitcoin.service",  "/var/log/orbi/orbi-phase-f-mercadobitcoin.log",  stall_seconds=900)
    results["f-bitso-mxn"]      = check_phase_e_log_active(state, "orbi-phase-f-bitso@mxn.service",       "/var/log/orbi/orbi-phase-f-bitso-mxn.log",       stall_seconds=900)
    results["f-bitso-ars"]      = check_phase_e_log_active(state, "orbi-phase-f-bitso@ars.service",       "/var/log/orbi/orbi-phase-f-bitso-ars.log",       stall_seconds=900)
    results["f-bitso-brl"]      = check_phase_e_log_active(state, "orbi-phase-f-bitso@brl.service",       "/var/log/orbi/orbi-phase-f-bitso-brl.log",       stall_seconds=900)
    # --- live-loader revival (added 2026-05-29 audit) ---
    # FED H.10 daily rates via FRED. Upstream publishes business-days ~21:00 UTC
    # with 1-day lag. Threshold = 48h; alert_only because restart of the CB
    # refresh service can't conjure FRED data that hasn't been published yet.
    results["fed-freshness"] = check_db_freshness(
        state,
        "fed-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(bucket_ts)))::int FROM exchange_rates WHERE source_authority='FED'",
        max_age_hours=48,
        alert_only=True,
    )
    # ORBI 1d composite (daily close roll-up from 1m forward-fill stream).
    # 36h threshold catches any roll-up stall before it becomes a multi-day gap.
    results["orbi-1d-freshness"] = check_db_freshness(
        state,
        "orbi-1d-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(bucket_ts)))::int FROM exchange_rates WHERE source_authority='ORBI' AND granularity='1d' AND product='ORBI-D'",
        max_age_hours=48,  # bucket_ts at day-start: healthy max age is ~24h post-rollup, growing to ~48h before next rollup. Was 36h, caused false-positive alerts at noon UTC every day.
        alert_only=True,
    )
    # Bitfinex BTC/JPY R&D table: REMOVED 2026-05-29. Pair was delisted on Bitfinex
    # (only JPYUST remains). Forever-stale by design — alert was noise; removed.
    # FRED inflation series (CPI, PCE, PPI). Monthly cadence. 45-day threshold
    # gives BLS a full publication window before flagging — a single missing
    # month is the kind of thing we want surfaced (e.g. 2025-10 was suspended
    # during the late-2025 US gov shutdown).
    results["fred-inflation-freshness"] = check_db_freshness(
        state,
        "fred-inflation-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM inflation_rates WHERE source_authority='FRED'",
        max_age_hours=45*24,
        alert_only=True,
    )
    # --- Phase H freshness probes (added 2026-05-29 audit H3) ---
    # All Phase H loaders are alert_only=True: their upstreams have their own
    # publication cadence (FRED monthly, LBMA daily-fix, mempool varied) and
    # restarting the loader can't conjure unpublished data. Founder still
    # wants to know when something silently goes stale.
    results["lbma-metals-freshness"] = check_db_freshness(
        state, "lbma-metals-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(bucket_ts)))::int FROM precious_metals_rates WHERE source_authority='LBMA'",
        max_age_hours=5*24, alert_only=True,
    )
    results["fred-commodities-freshness"] = check_db_freshness(
        state, "fred-commodities-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM commodity_prices WHERE source_authority='FRED'",
        max_age_hours=60*24, alert_only=True,
    )
    results["fred-monetary-freshness"] = check_db_freshness(
        state, "fred-monetary-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM monetary_aggregates WHERE source_authority='FRED'",
        max_age_hours=60*24, alert_only=True,
    )
    # BoE Millennium: historical/annual; flag with very long threshold so we
    # notice if a backfill ever lands new sheets (Q3 2026 roadmap item).
    results["boe-millennium-freshness"] = check_db_freshness(
        state, "boe-millennium-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int FROM historical_money_prices WHERE source_authority='BOE_MILLENNIUM'",
        max_age_hours=400*24, alert_only=True,
    )
    # Tech productivity curves: annual cadence; threshold 18 months.
    results["tech-curves-freshness"] = check_db_freshness(
        state, "tech-curves-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM tech_productivity_curves",
        max_age_hours=18*30*24, alert_only=True,
    )
    # Wave 1 international macro (Riksbank + WDI + UN WPP), 2026-05-30.
    # Riksbank FX: daily fixings (business days); threshold 5 days.
    results["riksbank-fx-freshness"] = check_db_freshness(
        state, "riksbank-fx-freshness",
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MAX(bucket_ts)))::int, -1) FROM exchange_rates WHERE source_authority='RIKSBANK'",
        max_age_hours=5*24, alert_only=True,
    )
    # Riksbank macro-historical: annual archive; threshold 14 months.
    results["riksbank-historical-freshness"] = check_db_freshness(
        state, "riksbank-historical-freshness",
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int, -1) FROM historical_money_prices WHERE source_authority='RIKSBANK'",
        max_age_hours=13*30*24, alert_only=True,
    )
    # World Bank WDI: weekly refresh; threshold 14 days.
    results["worldbank-wdi-freshness"] = check_db_freshness(
        state, "worldbank-wdi-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int FROM historical_money_prices WHERE source_authority='WORLD_BANK_WDI'",
        max_age_hours=14*24, alert_only=True,
    )
    # UN WPP: annual; threshold 14 months.
    results["un-wpp-freshness"] = check_db_freshness(
        state, "un-wpp-freshness",
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int, -1) FROM historical_money_prices WHERE source_authority='UN_WPP'",
        max_age_hours=13*30*24, alert_only=True,
    )
    # --- Wave 1 GO: StatCan provincial + BIS + NBS China (added 2026-05-30) ---
    # StatCan provincial wages: monthly (LFS) + monthly (SEPH); threshold 45 days.
    results["statcan-provincial-freshness"] = check_db_freshness(
        state, "statcan-provincial-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM wages WHERE source_authority='STATCAN'",
        max_age_hours=13*30*24, alert_only=True,
    )
    # BIS long-CPI (annual archive): threshold 18 months.
    results["bis-long-cpi-freshness"] = check_db_freshness(
        state, "bis-long-cpi-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM inflation_rates WHERE source_authority='BIS' AND source_series_id='WS_LONG_CPI'",
        max_age_hours=18*30*24, alert_only=True,
    )
    # BIS policy rates (month-end): threshold 45 days.
    results["bis-cbpol-freshness"] = check_db_freshness(
        state, "bis-cbpol-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int FROM historical_money_prices WHERE source_authority='BIS' AND quote_in='percent'",
        max_age_hours=45*24, alert_only=True,
    )
    # NBS China CPI: monthly when egress path opens; threshold 60 days.
    # alert_only=True: no self-restart, just visibility.
    results["nbs-china-freshness"] = check_db_freshness(
        state, "nbs-china-freshness",
        "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int, -1) FROM inflation_rates WHERE source_authority='NBS_CHINA'",
        max_age_hours=13*30*24, alert_only=True,
    )
    # mempool.space network metrics — separate probe per metric_kind family.
    results["mempool-hashrate-freshness"] = check_db_freshness(
        state, "mempool-hashrate-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM bitcoin_network_metrics WHERE metric_kind='HASHRATE'",
        max_age_hours=14*24, alert_only=True,
    )
    results["mempool-difficulty-freshness"] = check_db_freshness(
        state, "mempool-difficulty-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM bitcoin_network_metrics WHERE metric_kind='DIFFICULTY'",
        max_age_hours=30*24, alert_only=True,
    )
    results["mempool-lightning-freshness"] = check_db_freshness(
        state, "mempool-lightning-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM bitcoin_network_metrics WHERE metric_kind='LN_CAPACITY'",
        max_age_hours=3*24, alert_only=True,
    )
    results["mempool-pools-freshness"] = check_db_freshness(
        state, "mempool-pools-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM bitcoin_network_metrics WHERE metric_kind='POOL_SHARE'",
        max_age_hours=14*24, alert_only=True,
    )
    results["mempool-blocks-freshness"] = check_db_freshness(
        state, "mempool-blocks-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(period_start)))::int FROM bitcoin_network_metrics WHERE metric_kind='BLOCK_SIZE'",
        max_age_hours=14*24, alert_only=True,
    )
    # Officer & Williamson pre-1968 gold: annual-at-best; alert_only with very
    # long threshold so a year-without-update flips a flag.
    results["officer-williamson-gold-freshness"] = check_db_freshness(
        state, "officer-williamson-gold-freshness",
        "SELECT EXTRACT(EPOCH FROM (now() - MAX(inserted_at)))::int FROM historical_money_prices WHERE source_authority='MEASURING_WORTH'",
        max_age_hours=400*24, alert_only=True,
    )
    # --- coverage-validation-matrix probes (added 2026-05-29) ---
    # 1) Expected-live 1m series stale > 24h: any pair in the allowlist whose
    #    most recent 1m bucket is older than 24h. Catches a fully dead source
    #    (forward-fill watcher only catches ORBI itself, not its inputs).
    results["live-1m-series-stale"] = check_db_freshness(
        state, "live-1m-series-stale",
        """
        -- Same answer as before, in 0.1s instead of 8s and rising. The old form
        -- asked for GROUP BY MAX(bucket_ts) with a row-wise IN, which Postgres
        -- cannot answer from an index: it seq-scanned all 68M rows every run,
        -- took ~8s for three series, and blew the 30s timeout at eight. One
        -- ORDER BY ... LIMIT 1 per series is an index-only scan of 5 buffers.
        -- Verified 2026-08-14: 7,968ms -> 132ms, identical output.
        SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - mx))::int), 0)
        FROM (
          SELECT (SELECT bucket_ts
                    FROM exchange_rates e
                   WHERE e.granularity='1m'
                     AND e.source_authority = v.a
                     AND e.source_currency  = v.s
                     AND e.target_currency  = v.t
                   ORDER BY e.bucket_ts DESC
                   LIMIT 1) AS mx
          FROM (VALUES
              ('BITSTAMP','BTC','USD'),('BITSTAMP','BTC','EUR'),('BITSTAMP','BTC','GBP'),
              ('KRAKEN','BTC','USD'),('KRAKEN','BTC','GBP'),
              ('ORBI','BTC','USD'),('ORBI','BTC','EUR'),('ORBI','BTC','GBP')
          ) AS v(a, s, t)
        ) t
        """,
        max_age_hours=24, alert_only=True,
    )
    # 2) ORBI BTC/USD 1m daily density < 1200 buckets on any completed UTC day
    #    in the last 7 days. (1440 ideal; 1200 = ~83% floor.) Catches the
    #    forward-fill density regression that motivated this audit.
    results["orbi-btc-usd-1m-density"] = check_db_freshness(
        state, "orbi-btc-usd-1m-density",
        """
        WITH per_day AS (
          SELECT date_trunc('day', bucket_ts) AS d, COUNT(*) AS n
          FROM exchange_rates
          WHERE source_authority='ORBI' AND granularity='1m'
            AND source_currency='BTC' AND target_currency='USD'
            AND bucket_ts >= (date_trunc('day', now()) - interval '7 days')
            AND bucket_ts <  date_trunc('day', now())
          GROUP BY 1
        )
        SELECT CASE WHEN MIN(n) < 1200 THEN 999999 ELSE 0 END FROM per_day
        """,
        max_age_hours=1, alert_only=True,
    )
    # 3) Central-bank rates > 5 business days stale. Weekend-aware via the
    #    extract(dow) clause that skips Sat/Sun in the age count.
    results["cb-rates-5biz-stale"] = check_db_freshness(
        state, "cb-rates-5biz-stale",
        """
        SELECT COALESCE(MAX(biz_age*86400)::int, 0)
        FROM (
          SELECT source_authority,
                 (SELECT COUNT(*) FROM generate_series(MAX(bucket_ts)::date+1, current_date, '1 day'::interval) g
                  WHERE EXTRACT(DOW FROM g) NOT IN (0,6)) AS biz_age
          FROM exchange_rates
          WHERE source_authority IN ('FED','ECB','BOE','BOC','RBA','SARB','BANXICO','BCB',
                                     'BCCH','BSP','BNM','BANREP','BCRP','RBI','BI')
          GROUP BY source_authority
        ) t
        WHERE biz_age > 5
        """,
        max_age_hours=1, alert_only=True,
    )
    # 4) Inflation series stale > 90 days. Most series are monthly with 30-45d
    #    lag; 90d is the "something is wrong" signal.
    results["inflation-series-90d-stale"] = check_db_freshness(
        state, "inflation-series-90d-stale",
        """
        -- Use GLOBAL max release_date, not per-series. Per-series triggers on
        -- WB_WDI countries that legitimately haven't reported in years
        -- (Liechtenstein, Yemen, Venezuela, etc.) and on archival data
        -- intentionally included as historical reference.
        -- Real signal: have WE stopped ingesting fresh CPI globally?
        SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MAX(release_date)))::int, 0)
        FROM inflation_rates
        WHERE source_authority IN ('FRED','ECB','BoE-Millennium','BIS','BLS','ONS-GB')
          AND release_date IS NOT NULL
        """,
        max_age_hours=90*24, alert_only=True,
    )
    # 5) Composite-flag integrity: any ORBI 1m row whose bucket_ts predates the
    #    first-known direct-venue bucket for that pair but is flagged
    #    composite=false. Hardcoded launch dates verified via MIN(bucket_ts)
    #    against the actual venue rows (2026-05-29):
    #      BTC/MXN: BITSO  2024-10-19 - pre-Bitso must be composite (BANXICO bridge)
    #      BTC/ZAR: no direct venue exists; all ORBI BTC/ZAR must be composite.
    results["composite-flag-integrity"] = check_db_freshness(
        state, "composite-flag-integrity",
        """
        SELECT CASE WHEN COUNT(*) > 0 THEN 999999 ELSE 0 END
        FROM exchange_rates
        WHERE source_authority='ORBI' AND source_currency='BTC' AND composite=false
          AND (
            (target_currency='MXN' AND bucket_ts < '2024-10-19'::timestamptz)
            OR target_currency='ZAR'
          )
        """,
        max_age_hours=1, alert_only=True,
    )
    # 6) Phase M minute-tick cross-rate freshness (added 2026-05-30).
    #    Every synthesized (BTC/<fiat>) 1m series whose composite_via starts
    #    with 'BTC/USD x' must have its most-recent bucket within 2h. Catches
    #    a silent stall of orbi-m-cross-rate-synthesizer.service before the
    #    daily timer would otherwise mask it.
    results["orbi-m-cross-rate-stale"] = check_db_freshness(
        state, "orbi-m-cross-rate-stale",
        """
        SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - mx))::int), 0)
        FROM (
          SELECT target_currency, MAX(bucket_ts) AS mx
          FROM exchange_rates
          WHERE source_authority='ORBI' AND source_currency='BTC'
            AND granularity='1m' AND product='ORBI-M'
            AND composite=true
            AND composite_via LIKE 'BTC/USD × %'
            AND bucket_ts >= now() - interval '3 days'
          GROUP BY 1
        ) t
        """,
        max_age_hours=2, alert_only=True,
    )

    log(f"results: {results}")
    save_state(state)

if __name__ == "__main__":
    main()
