#!/usr/bin/env bash
# orbi-truthtable-freshness-probe.sh
#
# Enumerates every RLS-on table in the public schema at run time and alarms
# when one of them has gone frozen. Built because orbi-staleness-probe.sh
# only ever watched public.exchange_rates: the twelve truth tables in
# supabase-db/orange_world were never checked, and the public dataset froze
# for 93 days with nothing telling us (OR-T1370).
#
# Exit codes (see TRUTH_TABLE_FRESHNESS_AND_OWNERSHIP_CRON.md):
#   0  -- OK: every enumerated table is within its derived threshold
#   1  -- ALARM: a table is frozen, a loader has never succeeded, or the
#         enumerated table count shrank since the last run, AND the page
#         was delivered
#   2  -- ERROR: could not reach the database, a query failed, a table's
#         threshold could not be derived, a table's age could not be read as
#         a number of seconds, the state file could not be read or written,
#         the alert script is unusable, or the page could not be delivered.
#         Exit 1 always means someone was actually told; every other failure
#         is 2, and no path that could not reach a judgement may exit 0.
#
# Required env:
#   ORBI_PROBE_DSN            postgres DSN (postgres://user:pass@host:port/db)
#   -or- DATABASE_URL         fallback if ORBI_PROBE_DSN is unset
#
#   ORBI_ALERT_SCRIPT         absolute path to the host's alert script, called
#                             as "$ORBI_ALERT_SCRIPT" <level> <body>. Supplied
#                             by the systemd unit environment so no host path
#                             lives in this repo. The probe refuses to start
#                             (exit 2) if it is unset, missing, or not
#                             executable.
#
#   ORBI_FRESHNESS_STATE_FILE absolute path to a small file this probe uses to
#                             remember how many tables it enumerated last run,
#                             so a shrinking table list is loud instead of
#                             quietly leaving the list. Supplied by the unit
#                             environment for the same reason as the alert
#                             script: no host path lives in this repo.
#
# Optional env:
#   ORBI_MIN_THRESHOLD_SECONDS   floor for the derived per-table threshold,
#                                 default 14400 (4 hours). Stops an hourly
#                                 table paging on one missed run.
#   ORBI_MAX_THRESHOLD_SECONDS   cap for the derived per-table threshold,
#                                 default 1209600 (14 days). Stops a table
#                                 with sparse history from becoming
#                                 unalarmable.
#   ORBI_GAP_MULTIPLIER          multiplier applied to the p90 inter-fetch
#                                 gap, default 3. p90 rather than max, so one
#                                 historical outage does not raise the bar
#                                 above the next outage. 3x rather than 2x,
#                                 so a loader slipping a few hours off a
#                                 daily cadence is not noise.

set -uo pipefail

PROBE="orbi-truthtable-freshness-probe"
DSN="${ORBI_PROBE_DSN:-${DATABASE_URL:-}}"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
STATE_FILE="${ORBI_FRESHNESS_STATE_FILE:-}"
MIN_THRESHOLD_SECONDS="${ORBI_MIN_THRESHOLD_SECONDS:-14400}"
MAX_THRESHOLD_SECONDS="${ORBI_MAX_THRESHOLD_SECONDS:-1209600}"
GAP_MULTIPLIER="${ORBI_GAP_MULTIPLIER:-3}"

# The alert script must be usable BEFORE anything else runs. A probe that can
# detect a frozen table and page nobody is the defect this whole change
# exists to fix. These exit 2 (ERROR), never 1: 1 is the ALARM code and a
# misconfigured host must not look like a frozen table.
if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect a frozen table and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect a frozen table and page nobody" >&2
  exit 2
fi

if [[ -z "$STATE_FILE" ]]; then
  echo "[$PROBE] ERROR: ORBI_FRESHNESS_STATE_FILE is not set; cannot detect a shrinking table list without a persisted baseline" >&2
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

psql_run() {
  psql "$DSN" --no-password -t -A -F'|' --command "$1" 2>&1
}

# The shrink check is only as good as the baseline it compares against, and
# this is the only place that baseline is written. An unwritable state file (a
# unit installed without a writable StateDirectory, a full disk, a path typo)
# means the count is never stored, so the shrink comparison can never fire on
# any future run. Discarding that failure, which the success path used to do,
# made a could-not-check print "OK ... all fresh" and exit 0. Callers turn a
# false return into exit 2.
persist_count() {
  echo "$COUNT" > "$STATE_FILE" 2>/dev/null
}

# ---- validate env ---------------------------------------------------------

if [[ -z "$DSN" ]]; then
  alarm ERROR "ORBI_PROBE_DSN is not set; cannot enumerate truth tables"
  exit 2
fi

# ---- enumerate (never hardcode, never filter by name pattern) -------------
# OR-T1202's patch missed four tables because it used a fixed list of eight.
# This must always ask the catalogue, so a table added later is covered
# without anyone remembering to update a list.

TABLES_RAW=$(psql_run "
  SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   ORDER BY c.relname;")
RC=$?
if [[ $RC -ne 0 ]]; then
  alarm ERROR "could not enumerate RLS-on public tables (psql exit ${RC}): ${TABLES_RAW}"
  exit 2
fi

TABLES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TABLES+=("$line")
done <<< "$TABLES_RAW"
COUNT=${#TABLES[@]}

if [[ $COUNT -eq 0 ]]; then
  alarm ERROR "enumeration returned zero RLS-on public tables; either the catalogue query is wrong or every truth table lost RLS"
  exit 2
fi

# ---- shrink check -----------------------------------------------------------
# A table dropping out of the list (removed, or RLS switched off) must be
# loud, otherwise the next silent freeze hides by leaving the list.

# An ABSENT state file is the first run, and that is the only case where an
# empty baseline is legitimate. A state file that EXISTS but cannot be read,
# or that holds something other than a count, is a could-not-check: the old
# `|| true` turned it into an empty string and made the comparison below a
# silent no-op, so a truth table could leave the list unnoticed forever. That
# is the same silence the probe exists to end, so it is exit 2 naming the file.
PREV_COUNT=""
if [[ -e "$STATE_FILE" ]]; then
  if ! PREV_COUNT=$(tr -d '[:space:]' < "$STATE_FILE" 2>/dev/null); then
    alarm ERROR "the freshness state file ${STATE_FILE} exists but could not be read; the shrink check cannot run (UNKNOWN, not a pass)"
    exit 2
  fi
  if ! [[ "$PREV_COUNT" =~ ^[0-9]+$ ]]; then
    alarm ERROR "the freshness state file ${STATE_FILE} holds '${PREV_COUNT}', which is not a table count; the shrink check cannot run (UNKNOWN, not a pass)"
    exit 2
  fi
fi

if [[ -n "$PREV_COUNT" && "$COUNT" -lt "$PREV_COUNT" ]]; then
  if ! alarm ALARM "enumerated table count SHRANK from ${PREV_COUNT} to ${COUNT}: a truth table was dropped or lost row-level security"; then
    exit 2
  fi
  exit 1
fi

# ---- per-table freshness ----------------------------------------------------

STALE=()
for TABLE in "${TABLES[@]}"; do
  COL_RAW=$(psql_run "
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${TABLE}'
       AND column_name IN ('fetched_at','last_success_at')
     ORDER BY CASE column_name WHEN 'fetched_at' THEN 0 ELSE 1 END
     LIMIT 1;")
  RC=$?
  if [[ $RC -ne 0 ]]; then
    alarm ERROR "could not resolve a timestamp column for ${TABLE} (psql exit ${RC}): ${COL_RAW}"
    exit 2
  fi
  COL="${COL_RAW//[[:space:]]/}"
  if [[ -z "$COL" ]]; then
    alarm ERROR "${TABLE} has neither fetched_at nor last_success_at; cannot determine freshness (UNKNOWN, not a pass)"
    exit 2
  fi

  ROW=$(psql_run "
    WITH ts AS (
      SELECT DISTINCT date_trunc('second', \"${COL}\") AS ts
        FROM public.\"${TABLE}\"
       WHERE \"${COL}\" IS NOT NULL
       ORDER BY ts DESC LIMIT 60
    ), g AS (
      SELECT ts - lag(ts) OVER (ORDER BY ts) AS gap FROM ts
    )
    SELECT
      EXTRACT(EPOCH FROM (now() - (SELECT max(\"${COL}\") FROM public.\"${TABLE}\")))::bigint,
      (SELECT count(*) FROM ts),
      COALESCE((SELECT EXTRACT(EPOCH FROM percentile_disc(0.9) WITHIN GROUP (ORDER BY gap))
                  FROM g WHERE gap IS NOT NULL)::bigint, -1);")
  RC=$?
  if [[ $RC -ne 0 ]]; then
    alarm ERROR "freshness query failed for ${TABLE} (psql exit ${RC}): ${ROW}"
    exit 2
  fi

  IFS='|' read -r AGE DISTINCT_N P90 <<< "$ROW"
  AGE="${AGE//[[:space:]]/}"
  DISTINCT_N="${DISTINCT_N//[[:space:]]/}"
  P90="${P90//[[:space:]]/}"

  # NULL is not fine. max() over an all-NULL timestamp column is NULL, which
  # means this loader has NEVER succeeded -- worse than stale. It must never
  # read as "no data yet".
  if [[ -z "$AGE" || "$AGE" == "NULL" ]]; then
    STALE+=("${TABLE}: max(${COL}) is NULL, this loader has never succeeded")
    continue
  fi

  # An age that is not a non-negative integer means this table cannot be
  # classified at all. The concrete case is a NEGATIVE age: max(${COL}) is
  # AHEAD of the database clock, which happens when a loader stamps from a
  # fast clock or one upstream row carries a future timestamp. max() does not
  # move once such a row is stored, so the table would read as fresh for as
  # long as the timestamp stays in the future -- a single row stamped ten days
  # ahead buys a dead loader ten days of "OK", which is precisely the silent
  # freeze in OR-T1370. UNKNOWN is exit 2 naming the table, never a pass, the
  # same way the distinct-count and p90 checks below already behave.
  if ! [[ "$AGE" =~ ^[0-9]+$ ]]; then
    alarm ERROR "${TABLE}: age of max(${COL}) is '${AGE}', not a non-negative number of seconds; the newest stored timestamp may be ahead of the database clock, so freshness cannot be judged (UNKNOWN, not a pass)"
    exit 2
  fi

  # Fewer than two distinct timestamps means the gap, and therefore the
  # threshold, cannot be derived. That is UNKNOWN, which is exit 2 naming the
  # table, never a pass.
  if ! [[ "$DISTINCT_N" =~ ^[0-9]+$ ]] || [[ "$DISTINCT_N" -lt 2 ]]; then
    alarm ERROR "${TABLE} has fewer than 2 distinct ${COL} values; cannot derive a threshold (UNKNOWN, not a pass)"
    exit 2
  fi

  if ! [[ "$P90" =~ ^-?[0-9]+$ ]] || [[ "$P90" -lt 0 ]]; then
    alarm ERROR "${TABLE} produced no usable p90 inter-fetch gap; cannot derive a threshold"
    exit 2
  fi

  THRESHOLD=$(( GAP_MULTIPLIER * P90 ))
  if [[ $THRESHOLD -lt $MIN_THRESHOLD_SECONDS ]]; then
    THRESHOLD=$MIN_THRESHOLD_SECONDS
  fi
  if [[ $THRESHOLD -gt $MAX_THRESHOLD_SECONDS ]]; then
    THRESHOLD=$MAX_THRESHOLD_SECONDS
  fi

  if [[ "$AGE" -gt "$THRESHOLD" ]]; then
    STALE+=("${TABLE}: ${COL} is ${AGE}s old (derived threshold ${THRESHOLD}s, p90 gap ${P90}s)")
  fi
done

if [[ ${#STALE[@]} -gt 0 ]]; then
  BODY="${#STALE[@]} of ${COUNT} truth tables frozen: $(printf '%s; ' "${STALE[@]}")"
  if ! alarm ALARM "$BODY"; then
    exit 2
  fi
  # The enumeration itself was sound even though a table is stale; persist it
  # so the shrink check next run compares against a real baseline. If that
  # write fails, the page above has already gone out but the baseline is lost
  # with it, so the run ends 2 rather than 1: the operator must fix the state
  # file, and the frozen table is already named in the page they just got.
  if ! persist_count; then
    alarm ERROR "could not write the freshness state file ${STATE_FILE} after paging on ${#STALE[@]} frozen table(s); the table-count baseline was not persisted, so the shrink check cannot run"
    exit 2
  fi
  exit 1
fi

if ! persist_count; then
  alarm ERROR "could not write the freshness state file ${STATE_FILE}; the table-count baseline was not persisted, so a shrinking table list would never be detected (UNKNOWN, not a pass)"
  exit 2
fi

echo "[$PROBE] OK: ${COUNT} of ${COUNT} examined, all fresh"
exit 0
