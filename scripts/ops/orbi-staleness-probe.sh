#!/usr/bin/env bash
# orbi-staleness-probe.sh
#
# Checks whether the ORBI 1-minute exchange-rate table has fresh data.
# Exit codes (see STALENESS_PROBE_CRON.md for the full spec):
#   0  -- OK: newest bucket_ts is within the threshold
#   1  -- STALE: newest bucket_ts is older than STALE_THRESHOLD_MINUTES
#   2  -- ERROR: could not reach the database, or query failed
#
# Required env:
#   ORBI_PROBE_DSN       postgres DSN (postgres://user:pass@host:port/db)
#   -or- DATABASE_URL    fallback if ORBI_PROBE_DSN is unset
#
# Optional env:
#   STALE_THRESHOLD_MINUTES   integer, default 10
#   ZULIP_ALARM_URL           webhook endpoint (alarm fires only when set)
#   ZULIP_ALARM_KEY           bearer token for that endpoint
#   ZULIP_ALARM_TO            destination stream:topic for alarm message

set -uo pipefail

PROBE="orbi-staleness-probe"
DSN="${ORBI_PROBE_DSN:-${DATABASE_URL:-}}"
THRESHOLD="${STALE_THRESHOLD_MINUTES:-10}"

# ---- helpers ----------------------------------------------------------------

alarm() {
  local level="$1"
  local body="$2"
  echo "[$PROBE] $level: $body" >&2
  if [[ -n "${ZULIP_ALARM_URL:-}" && -n "${ZULIP_ALARM_KEY:-}" ]]; then
    local to="${ZULIP_ALARM_TO:-Delivery|orbi-staleness-probe}"
    curl -s -o /dev/null \
      -H "Authorization: Bearer ${ZULIP_ALARM_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"to\":\"${to}\",\"level\":\"${level}\",\"body\":\"${body}\"}" \
      "${ZULIP_ALARM_URL}" || true
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
  alarm STALE "max(bucket_ts) is ${AGE_SECONDS}s old (threshold ${THRESHOLD_SECONDS}s / ${THRESHOLD}m)"
  exit 1
fi

echo "[$PROBE] OK: max(bucket_ts) is ${AGE_SECONDS}s old (threshold ${THRESHOLD_SECONDS}s)"
exit 0
