#!/usr/bin/env bash
# orbi-ownership-drift-probe.sh
#
# Catches the specific mechanism behind the 93-day truth-table freeze
# (OR-T1370): a restore silently changed eight table owners, which turned on
# RLS enforcement for the loader role. OR-T1202 restores the owners; this
# probe is what makes that durable, because ownership is an invisible
# attribute a future restore can strip again without a sound.
#
# Exit codes (see TRUTH_TABLE_FRESHNESS_AND_OWNERSHIP_CRON.md):
#   0  -- OK: every RLS-on public table is owned by ORBI_EXPECTED_OWNER and
#         none forces row-level security on its own owner
#   1  -- ALARM: at least one table has drifted, AND the page was delivered
#   2  -- ERROR: could not reach the database, the query failed, the alert
#         script is unusable, or the page could not be delivered. Exit 1
#         always means someone was actually told; every other failure is 2.
#
# Required env:
#   ORBI_PROBE_DSN       postgres DSN (postgres://user:pass@host:port/db)
#   -or- DATABASE_URL    fallback if ORBI_PROBE_DSN is unset
#
#   ORBI_ALERT_SCRIPT    absolute path to the host's alert script, called as
#                        "$ORBI_ALERT_SCRIPT" <level> <body>. Supplied by the
#                        systemd unit environment so no host path lives in
#                        this repo. The probe refuses to start (exit 2) if it
#                        is unset, missing, or not executable.
#
# Optional env:
#   ORBI_EXPECTED_OWNER  the role every RLS-on public table must be owned by,
#                        default orbi_writer.

set -uo pipefail

PROBE="orbi-ownership-drift-probe"
DSN="${ORBI_PROBE_DSN:-${DATABASE_URL:-}}"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
EXPECTED_OWNER="${ORBI_EXPECTED_OWNER:-orbi_writer}"

if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect ownership drift and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect ownership drift and page nobody" >&2
  exit 2
fi

# ---- helpers ------------------------------------------------------------

alarm() {
  local level="$1"
  local body="$2"
  echo "[$PROBE] $level: $body" >&2
  if ! "$ALERT_SCRIPT" "$level" "$body"; then
    echo "[$PROBE] ALERT DELIVERY FAILED: $ALERT_SCRIPT exited non-zero" >&2
    return 1
  fi
}

# ---- validate env ---------------------------------------------------------

if [[ -z "$DSN" ]]; then
  alarm ERROR "ORBI_PROBE_DSN is not set; cannot check table ownership"
  exit 2
fi

# ---- enumerate and check ---------------------------------------------------
# Same enumeration as the freshness probe: RLS-on public tables from the
# catalogue at run time, never a hardcoded or pattern-filtered list.

ROWS=$(psql "$DSN" --no-password -t -A -F'|' --command "
  SELECT c.relname, pg_get_userbyid(c.relowner), c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   ORDER BY c.relname;" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  alarm ERROR "could not enumerate RLS-on public tables (psql exit ${RC}): ${ROWS}"
  exit 2
fi

COUNT=0
DRIFTED=()
while IFS='|' read -r TABLE OWNER FORCE; do
  [[ -z "$TABLE" ]] && continue
  COUNT=$((COUNT + 1))
  if [[ "$OWNER" != "$EXPECTED_OWNER" ]]; then
    DRIFTED+=("${TABLE}: owner is '${OWNER}', expected '${EXPECTED_OWNER}'")
  elif [[ "$FORCE" == "t" ]]; then
    DRIFTED+=("${TABLE}: relforcerowsecurity is true, which forces RLS even on its own owner")
  fi
done <<< "$ROWS"

if [[ $COUNT -eq 0 ]]; then
  alarm ERROR "enumeration returned zero RLS-on public tables; either the catalogue query is wrong or every truth table lost RLS"
  exit 2
fi

if [[ ${#DRIFTED[@]} -gt 0 ]]; then
  BODY="${#DRIFTED[@]} of ${COUNT} RLS-on public tables have drifted ownership: $(printf '%s; ' "${DRIFTED[@]}")"
  if ! alarm ALARM "$BODY"; then
    exit 2
  fi
  exit 1
fi

echo "[$PROBE] OK: ${COUNT} of ${COUNT} examined, all owned by ${EXPECTED_OWNER}, none forcing RLS on owner"
exit 0
