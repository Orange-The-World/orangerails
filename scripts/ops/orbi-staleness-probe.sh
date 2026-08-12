#!/usr/bin/env bash
# orbi-staleness-probe.sh
#
# Checks whether the ORBI 1-minute exchange-rate table has fresh data.
# Exit codes (see STALENESS_PROBE_CRON.md for the full spec):
#   0  -- OK: newest bucket_ts is within the threshold
#   1  -- STALE: newest bucket_ts is older than STALE_THRESHOLD_MINUTES AND the
#         page was delivered
#   2  -- ERROR: could not reach the database, query failed, the alert script is
#         unusable, or the page could not be delivered. Exit 1 therefore always
#         means someone was actually told; every other failure is 2.
#
# Required env:
#   ORBI_PROBE_DSN       postgres DSN (postgres://user:pass@host:port/db)
#   -or- DATABASE_URL    fallback if ORBI_PROBE_DSN is unset
#
#   ORBI_ALERT_SCRIPT    absolute path to the host's Zulip alert script, called
#                        as "$ORBI_ALERT_SCRIPT" <level> <body>. Supplied by the
#                        systemd unit environment so no host path lives in this
#                        repo. The probe refuses to start (exit 2) if it is unset,
#                        missing, or not executable.
#
# Optional env:
#   STALE_THRESHOLD_MINUTES   integer, default 10

set -uo pipefail

PROBE="orbi-staleness-probe"
DSN="${ORBI_PROBE_DSN:-${DATABASE_URL:-}}"
THRESHOLD="${STALE_THRESHOLD_MINUTES:-10}"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"

# The alert script must be usable BEFORE anything else runs. A probe that can
# detect staleness and page nobody is the defect this whole change exists to fix.
# These exit 2 (ERROR), never 1, because 1 is the STALE code and a misconfigured
# host must not look like a stale table.
if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect staleness and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect staleness and page nobody" >&2
  exit 2
fi

# ---- helpers ----------------------------------------------------------------

alarm() {
  local level="$1"
  local body="$2"
  echo "[$PROBE] $level: $body" >&2
  if ! "$ALERT_SCRIPT" "$level" "$body"; then
    echo "[$PROBE] ALERT DELIVERY FAILED: $ALERT_SCRIPT exited non-zero" >&2
    return 1
  fi
}

# ---- validate env -----------------------------------------------------------

if [[ -z "$DSN" ]]; then
  alarm ERROR "ORBI_PROBE_DSN is not set; cannot query exchange_rates"
  exit 2
fi

# ---- query ------------------------------------------------------------------

PSQL_OUT=$(psql "$DSN" --no-password -t -A \
  --command "SELECT EXTRACT(EPOCH FROM (now() - bucket_ts))::bigint \
             FROM public.exchange_rates \
             WHERE source_currency = 'BTC' \
               AND target_currency = 'USD' \
               AND granularity = '1m' \
               AND status = 'CONFIRMED' \
             ORDER BY bucket_ts DESC LIMIT 1;" 2>&1)
PSQL_RC=$?

if [[ $PSQL_RC -ne 0 ]]; then
  alarm ERROR "DB unreachable or query failed (psql exit ${PSQL_RC}): ${PSQL_OUT}"
  exit 2
fi

# Trim whitespace
AGE_SECONDS="${PSQL_OUT//[[:space:]]/}"

# Empty result means the table has no 1m rows at all -- treat as an error, not
# as stale, because the probe cannot distinguish "nothing yet" from "broken".
if [[ -z "$AGE_SECONDS" || "$AGE_SECONDS" == "NULL" ]]; then
  alarm ERROR "exchange_rates has no rows with granularity=1m -- table empty or filter wrong"
  exit 2
fi

# Guard: result must be a plain integer
if ! [[ "$AGE_SECONDS" =~ ^[0-9]+$ ]]; then
  alarm ERROR "Unexpected query result (not an integer): '${AGE_SECONDS}'"
  exit 2
fi

THRESHOLD_SECONDS=$(( THRESHOLD * 60 ))

if (( AGE_SECONDS > THRESHOLD_SECONDS )); then
  if ! alarm STALE "max(bucket_ts) is ${AGE_SECONDS}s old (threshold ${THRESHOLD_SECONDS}s / ${THRESHOLD}m)"; then
    echo "[$PROBE] ERROR: table is STALE and the page could NOT be delivered; exiting 2 so an undelivered STALE never reads as a delivered one" >&2
    exit 2
  fi
  exit 1
fi

echo "[$PROBE] OK: max(bucket_ts) is ${AGE_SECONDS}s old (threshold ${THRESHOLD_SECONDS}s)"
exit 0
