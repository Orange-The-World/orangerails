#!/usr/bin/env python3
"""
Local → orbi-prod sync for ORBI exchange_rates + exchange_rate_resolutions.

Runs every 60s via systemd timer. Pushes rows written to local in the last
N minutes that aren't already in Cloud. Uses ON CONFLICT DO NOTHING so safe
to overlap or re-run.

State: keeps the last-synced bucket_ts in /tmp/orbi-sync-state.json.
On first run, defaults to (now - 6 hours) so it doesn't try to backfill
everything (the Phase A backfill handles history).
"""
import json, os, sys, subprocess, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ORBI_LOCAL_DB_URL is stored in /opt/bb-support/.env (plain, not sops yet).
def _load_local_dsn():
    if "ORBI_LOCAL_DB_URL" in os.environ:
        return os.environ["ORBI_LOCAL_DB_URL"]
    try:
        for line in open("/opt/bb-support/.env"):
            if line.startswith("ORBI_LOCAL_DB_URL="):
                v = line.split("=", 1)[1].strip()
                return v[1:-1] if (v.startswith('"') and v.endswith('"')) else v
    except: pass
    raise RuntimeError("ORBI_LOCAL_DB_URL not found in env or .env file")


# H3: parse DSN into PG* env vars so psql doesn't see the password in argv.
def _pg_env_from_dsn(dsn):
    """postgres://user:pw@host:port/db -> {PGHOST,PGPORT,PGUSER,PGPASSWORD,PGDATABASE}"""
    import urllib.parse
    p = urllib.parse.urlparse(dsn)
    return {
        "PGHOST": p.hostname or "127.0.0.1",
        "PGPORT": str(p.port or 5432),
        "PGUSER": urllib.parse.unquote(p.username or ""),
        "PGPASSWORD": urllib.parse.unquote(p.password or ""),
        "PGDATABASE": (p.path or "/").lstrip("/"),
    }

EX_CONFIG = 78
ORBI_PROD_REF = "sqcventmypowhbaceufy"
ORBI_PROD_HOST = f"{ORBI_PROD_REF}.supabase.co"


def _require_orbi_prod_target():
    """Fail before any local read or network call unless the target is exactly orbi-prod."""
    cloud_url = os.environ.get("ORBI_PROD_SUPABASE_URL", "")
    parsed = urllib.parse.urlparse(cloud_url)
    host = (parsed.hostname or "").lower()
    supplied_ref = host.split(".", 1)[0] if host else "<missing>"
    try:
        port = parsed.port
    except ValueError:
        port = -1
    if (
        parsed.scheme != "https"
        or host != ORBI_PROD_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        print(
            "REFUSING OR-T2710: ORBI sync target must be "
            f"https://{ORBI_PROD_HOST}; got ref {supplied_ref}",
            file=sys.stderr,
        )
        raise SystemExit(EX_CONFIG)

    cloud_token = os.environ.get("ORBI_PROD_ACCESS_TOKEN")
    if not cloud_token:
        print(
            "REFUSING OR-T2710: ORBI_PROD_ACCESS_TOKEN is required for orbi-prod",
            file=sys.stderr,
        )
        raise SystemExit(EX_CONFIG)
    return cloud_token, cloud_url, ORBI_PROD_REF


CLOUD_TOK, CLOUD_URL, CLOUD_REF = _require_orbi_prod_target()
LOCAL_DSN = _load_local_dsn()

# Defense-in-depth: R&D source authorities MUST NEVER be pushed to Cloud.
# These are research-only ingests (Coinbase Exchange + Bitfinex license terms
# permit personal/research use only -- never republication or API exposure).
# If a row with any of these authorities is ever seen here, abort the push and
# scream -- that means someone wrote an R&D row to the production table.
RND_BLOCKED_AUTHORITIES = ('COINBASE_EXCHANGE', 'BITFINEX', 'KAIKO_PREVIEW', 'CCDATA_PREVIEW')
RND_BLOCKED_SCHEMAS = ('rnd', 'research')

STATE_FILE = "/tmp/orbi-sync-state.json"
LOG = "/tmp/orbi-sync-local-to-cloud.log"
BATCH_LIMIT = 1000
LOOKBACK_INIT_HOURS = 6

def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}"
    # File logging is best-effort; on PermissionError/OSError fall back
    # to stdout/stderr (journald-routed). 2026-06-04 root-owned log incident.
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
    init = (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_INIT_HOURS)).isoformat()
    return {"last_bucket_ts": init, "last_rate_id": "00000000-0000-0000-0000-000000000000"}

def save_state(s):
    with open(STATE_FILE, "w") as f: json.dump(s, f)

def psql_query(sql):
    r = subprocess.run(["psql", "-At", "-F", "\x1f", "-c", sql], capture_output=True, text=True, timeout=60, env={**os.environ, **_pg_env_from_dsn(LOCAL_DSN)})
    if r.returncode != 0:
        log(f"  local psql FAIL: {r.stderr[:200]}")
        return None
    rows = []
    for line in r.stdout.strip().split("\n"):
        if line:
            rows.append(line.split("\x1f"))
    return rows

def cloud_exec(sql, timeout=60):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{CLOUD_REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization":"Bearer "+CLOUD_TOK,"Content-Type":"application/json","User-Agent":"orbi-sync/1.0"},
        method="POST",
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        log(f"  cloud HTTP {e.code}: {e.read().decode()[:120]}")
        return None
    except Exception as e:
        log(f"  cloud err: {str(e)[:120]}")
        return None

def sql_literal(v):
    if v is None or v == "": return "NULL"
    if v in ("t","true"): return "TRUE"
    if v in ("f","false"): return "FALSE"
    raw = str(v)
    # M10: strip NUL + tab + newline + carriage-return; PG cannot store NUL in text,
    # and the other control chars can break the SQL stream or multi-statement parsing.
    raw = raw.replace(chr(0), "").replace(chr(9), " ").replace(chr(10), " ").replace(chr(13), " ")
    s = raw.replace("'", "''")
    return f"'{s}'"

def sync_rates(state):
    cols = ["id","source_currency","target_currency","bucket_ts","granularity","product","rate","tier","composite","composite_via","provider_count","status","superseded_by_id","fetched_at","computed_at","provenance","source_authority"]
    sql = (
        f"SELECT {','.join(cols)} FROM exchange_rates "
        f"WHERE bucket_ts > '{state['last_bucket_ts']}' AND source_authority IN ('ORBI','ECB','BANXICO','BCB','BOC','FED','BOE','RBA','SNB','BOJ','BCCH','BLOCKCHAIN_COM','BSP','BCRP','BNM','BI','BANREP','SARB','RBI') AND source_authority NOT IN ('COINBASE_EXCHANGE','BITFINEX','KAIKO_PREVIEW','CCDATA_PREVIEW') "
        f"ORDER BY bucket_ts, id LIMIT {BATCH_LIMIT}"
    )
    rows = psql_query(sql)
    if not rows: return state, 0
    # REGRESSION GUARD: if a Coinbase/Bitfinex/KAIKO/CCData row ever appears in
    # the production exchange_rates select, abort. The select is allow-listed
    # above, so this should be impossible -- but if it ever fires, a bug has
    # routed R&D data into the production table and we MUST NOT push it.
    sa_idx = cols.index('source_authority')
    bad = [r for r in rows if r[sa_idx] in RND_BLOCKED_AUTHORITIES]
    if bad:
        log(f'CRITICAL: {len(bad)} R&D rows found in production exchange_rates select; refusing to push. '
            f'Sample authority: {bad[0][sa_idx]}. Investigate and clean before resuming sync.')
        try:
            subprocess.run(['/opt/bb-support/scripts/orbi-signal-alert.sh',
                            'ORBI sync ABORTED -- R&D rows in production',
                            f'{len(bad)} rows with authority in {RND_BLOCKED_AUTHORITIES} found in production exchange_rates. Sync halted.'],
                           timeout=15)
        except Exception:
            pass
        return state, -1
    # Build multi-VALUES INSERT
    values = []
    for r in rows:
        vals = ",".join(sql_literal(r[i]) for i in range(len(cols)))
        values.append(f"({vals})")
    ins_sql = (
        f"INSERT INTO exchange_rates ({','.join(cols)}) VALUES "
        + ",".join(values)
        + " ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority) DO NOTHING"
    )
    res = cloud_exec(ins_sql, timeout=90)
    if res is None: return state, -1
    # Advance state to the last bucket_ts of this batch
    state["last_bucket_ts"] = rows[-1][3]  # bucket_ts column index
    return state, len(rows)

def main():
    state = load_state()
    state, n = sync_rates(state)
    if n > 0:
        save_state(state)
        log(f"synced {n} rates; cursor → {state['last_bucket_ts']}")
    elif n == 0:
        log("no new rates")
    else:
        log("rate sync FAILED, keeping cursor")

if __name__ == "__main__":
    main()
