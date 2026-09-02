#!/usr/bin/env bash
# orbi-anon-acl-probe.sh
#
# Asserts the anon-privilege invariants in schema public on BOTH Supabase
# clusters (dev fzwmnzmtqidumdqjdddz, prod lcdicqalreskibdfxkzb), hourly.
# Design spec: wiki "anon-acl-invariants-scheduled-assertion-design-and-
# build-spec-or-t1408". Out of OR-T1408, built for OR-T1418.
#
# WHY: these are default privileges. They fire again on every object a role
# creates, so a fix applied once is a state, not an end. The anon-write
# problem has already been fixed three separate times in one week
# (OR-T1331/SQLA-00256, OR-T1394's dev sequence fix, OR-T1407's migration).
# Nothing until this script tells us if it comes back.
#
# THE FOUR ASSERTIONS, all read-only, all sub-second, run against each
# cluster independently:
#
#   A1  No relation in schema public is owned by anything other than
#       postgres, and no function in public is owned by anything other than
#       postgres. This is the precondition for OR-T1388's unreachable
#       supabase_admin default ACL to ever matter: it grants anon full
#       write, but only on an object supabase_admin actually owns.
#
#   A2  Default privileges for role postgres in schema public: the ANON
#       ENTRY ONLY. Expected exactly one row, (objtype r, privilege
#       SELECT). Any row for objtype S or f naming anon is red. Any
#       privilege on r other than SELECT is red. Absence of the r/SELECT
#       row is also red -- losing it silently changes what a new table
#       does. Never assert the whole ACL string: dev and prod already
#       differ on the non-anon parts of the same row (dev's r carries
#       postgres=arwdDxtm, prod's does not; authenticated is arwdDxtm on
#       dev, arwd on prod), and that divergence is real and out of scope.
#
#   A3  The set of (relkind, relation, privilege) where anon holds a
#       NON-SELECT privilege in public, across every relkind, must equal
#       EXACTLY {(r,adapter_requests,INSERT), (r,waitlist,INSERT)}. This is
#       a merged set-equality assertion: the original design had two
#       assertions here ("anon holds no non-SELECT privilege" and "anon
#       still holds INSERT on the two signup tables") that directly
#       contradict each other on a correct cluster. Set equality is
#       strictly stronger and catches both directions: an extra member is
#       an escalation, a missing member is a broken public signup form.
#       Deliberately NOT filtered by relkind -- filtering to r and p is
#       exactly how a sequence hole (rwU on two sequences) survived three
#       prior sweeps.
#
#   A4  Could-not-check is its own outcome, never folded into a pass. A
#       connection failure, a query error, or an empty result where a row
#       was required, all produce exit 2 for that cluster.
#
# Exit codes (amended for hourly dedup, see below):
#   0  -- OK: every assertion passed on every cluster.
#   1  -- ALARM: at least one assertion failed on at least one cluster, no
#         cluster was unreachable, AND (this run delivered a page OR an
#         identical fingerprint was already delivered within the last 24h
#         and the state file recording that delivery was readable).
#   2  -- ERROR: any cluster could not be checked (bad DSN, query failure),
#         the alert script is unusable, the state file could not be read or
#         written, or a page that needed to go out could not be delivered.
#         A misconfigured host must never look like a clean cluster, and an
#         undelivered alarm must never read as a delivered one.
#
# PER-CLUSTER INDEPENDENCE: one cluster being unreachable never suppresses
# the other cluster's real result. Both are always run; the worst outcome
# wins (2 beats 1 beats 0). Every alarm line names its cluster and, for A2
# and A3, the offending object and privilege.
#
# HOURLY DEDUP, the one piece of state: a stable fingerprint of the full
# failure set (cluster plus every sorted offending line) is compared to the
# last one recorded in ANON_ACL_STATE_FILE. A page goes out immediately when
# the fingerprint changes (including clean-to-red and one red shape to a
# different one), or when the last recorded page for the SAME fingerprint is
# 24h or older. Otherwise the page is suppressed and the run still reports
# exit 1 (a page was already delivered for this exact state, and this run
# proved the state file recording that is still readable).
#
# Required env:
#   ANON_ACL_DSN_DEV      postgres DSN for fzwmnzmtqidumdqjdddz
#   ANON_ACL_DSN_PROD     postgres DSN for lcdicqalreskibdfxkzb
#   ORBI_ALERT_SCRIPT     absolute path to the host's existing alert script,
#                         called as "$ORBI_ALERT_SCRIPT" <level> <body>.
#                         Supplied by the systemd unit environment so no
#                         host path lives in this repo. Checked BEFORE any
#                         DB connection opens, same as the existing probes.
#   ANON_ACL_STATE_FILE   absolute path to a small file recording the last
#                         fingerprint paged and when. Must live on a path
#                         that persists across runs (not /tmp), writable by
#                         the unit's user. Checked before any DB connection
#                         opens: a misconfigured host must not look clean.
#
# Optional env:
#   ANON_ACL_DEDUP_SECONDS   repeat-page suppression window, default 86400.
#
# One cluster's DSN missing is NOT a fatal config error for the whole probe:
# that cluster reports could-not-check (its own kind of red) while the other
# cluster's real result still counts. Both DSN variables being genuinely
# required is enforced by that cluster then always contributing an ERROR.

set -uo pipefail

PROBE="orbi-anon-acl-probe"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
STATE_FILE="${ANON_ACL_STATE_FILE:-}"
DEDUP_SECONDS="${ANON_ACL_DEDUP_SECONDS:-86400}"

# The alert script and the state file path must both be usable BEFORE
# anything else runs -- a probe that can find a defect and tell nobody, or
# that cannot prove its own dedup state, is the exact class of defect this
# whole family of scripts exists to close. Exit 2 (ERROR), never 1 or 0.
if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect drift and page nobody" >&2
  exit 2
fi
if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect drift and page nobody" >&2
  exit 2
fi
if [[ -z "$STATE_FILE" ]]; then
  echo "[$PROBE] ERROR: ANON_ACL_STATE_FILE is not set; the probe cannot prove its dedup state and must not run" >&2
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

# run_query DSN SQL -- sets QOUT (rows, pipe-separated) and QRC.
run_query() {
  QOUT=$(psql "$1" --no-password -t -A -F'|' --command "$2" 2>&1)
  QRC=$?
}

# ---- per-cluster check --------------------------------------------------
# Populates the global arrays ALARM_LINES and ERROR_LINES (already prefixed
# with "<cluster>: ") and returns 0/1/2 as this cluster's own worst outcome.

check_cluster() {
  local cluster="$1" dsn="$2"
  local -a c_alarm=() c_error=()

  if [[ -z "$dsn" ]]; then
    c_error+=("${cluster}: DSN not configured (ANON_ACL_DSN_${cluster^^} unset)")
    ERROR_LINES+=("${c_error[@]}")
    return 2
  fi

  # -- A1: ownership -------------------------------------------------------
  run_query "$dsn" "select c.relname, c.relkind::text, pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S','f') and pg_get_userbyid(c.relowner) <> 'postgres' order by 1,2;"
  if [[ $QRC -ne 0 ]]; then
    c_error+=("${cluster}: A1 relation-ownership query failed: ${QOUT}")
  else
    while IFS='|' read -r RELNAME RELKIND OWNER; do
      [[ -z "$RELNAME" ]] && continue
      c_alarm+=("${cluster} A1: ${RELNAME} (relkind ${RELKIND}) is owned by '${OWNER}', expected 'postgres'")
    done <<< "$QOUT"
  fi

  run_query "$dsn" "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and pg_get_userbyid(p.proowner) <> 'postgres';"
  if [[ $QRC -ne 0 ]]; then
    c_error+=("${cluster}: A1 function-ownership query failed: ${QOUT}")
  elif ! [[ "$QOUT" =~ ^[0-9]+$ ]]; then
    c_error+=("${cluster}: A1 function-ownership query returned a non-integer: '${QOUT}'")
  elif [[ "$QOUT" -gt 0 ]]; then
    c_alarm+=("${cluster} A1: ${QOUT} function(s) in public are not owned by postgres")
  fi

  # -- A2: default privileges, anon entry only ------------------------------
  run_query "$dsn" "select d.defaclobjtype::text, x.privilege_type from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace, lateral aclexplode(d.defaclacl) x join pg_roles g on g.oid=x.grantee where n.nspname='public' and pg_get_userbyid(d.defaclrole)='postgres' and g.rolname='anon' order by 1,2;"
  if [[ $QRC -ne 0 ]]; then
    c_error+=("${cluster}: A2 default-privilege query failed: ${QOUT}")
  else
    local saw_r_select=0
    while IFS='|' read -r OBJTYPE PRIV; do
      [[ -z "$OBJTYPE" ]] && continue
      if [[ "$OBJTYPE" == "r" && "$PRIV" == "SELECT" ]]; then
        saw_r_select=1
      else
        c_alarm+=("${cluster} A2: unexpected default anon privilege, objtype='${OBJTYPE}' privilege='${PRIV}' (only r/SELECT is allowed)")
      fi
    done <<< "$QOUT"
    if [[ $saw_r_select -eq 0 ]]; then
      c_alarm+=("${cluster} A2: the required default anon SELECT on relations (objtype r) is MISSING; this silently changes what every new public table grants")
    fi
  fi

  # -- A3: set-equality on anon non-SELECT privileges -----------------------
  run_query "$dsn" "select c.relkind::text, c.relname, x.privilege_type from pg_class c join pg_namespace n on n.oid=c.relnamespace, lateral aclexplode(c.relacl) x join pg_roles g on g.oid=x.grantee where n.nspname='public' and g.rolname='anon' and x.privilege_type <> 'SELECT' order by 1,2,3;"
  if [[ $QRC -ne 0 ]]; then
    c_error+=("${cluster}: A3 anon-privilege query failed: ${QOUT}")
  else
    local -A expected=( ["r|adapter_requests|INSERT"]=1 ["r|waitlist|INSERT"]=1 )
    local -A seen=()
    while IFS='|' read -r RELKIND RELNAME PRIV; do
      [[ -z "$RELNAME" ]] && continue
      local key="${RELKIND}|${RELNAME}|${PRIV}"
      seen["$key"]=1
      if [[ -z "${expected[$key]:-}" ]]; then
        c_alarm+=("${cluster} A3: EXTRA anon privilege, not in the allowed set: ${RELKIND}:${RELNAME}:${PRIV} (privilege escalation)")
      fi
    done <<< "$QOUT"
    for key in "${!expected[@]}"; do
      if [[ -z "${seen[$key]:-}" ]]; then
        IFS='|' read -r RELKIND RELNAME PRIV <<< "$key"
        c_alarm+=("${cluster} A3: MISSING required anon privilege: ${RELKIND}:${RELNAME}:${PRIV} (broken public signup form)")
      fi
    done
  fi

  ALARM_LINES+=("${c_alarm[@]}")
  ERROR_LINES+=("${c_error[@]}")

  if [[ ${#c_error[@]} -gt 0 ]]; then
    return 2
  elif [[ ${#c_alarm[@]} -gt 0 ]]; then
    return 1
  fi
  return 0
}

# ---- run both clusters, independently ------------------------------------

ALARM_LINES=()
ERROR_LINES=()
OVERALL=0

check_cluster "dev" "${ANON_ACL_DSN_DEV:-}"
S=$?
[[ $S -gt $OVERALL ]] && OVERALL=$S

check_cluster "prod" "${ANON_ACL_DSN_PROD:-}"
S=$?
[[ $S -gt $OVERALL ]] && OVERALL=$S

# ---- decide ----------------------------------------------------------------

if [[ $OVERALL -eq 2 ]]; then
  BODY="anon ACL probe could not fully check: $(printf '%s; ' "${ERROR_LINES[@]}")"
  if [[ ${#ALARM_LINES[@]} -gt 0 ]]; then
    BODY="${BODY} Also red on what WAS checked: $(printf '%s; ' "${ALARM_LINES[@]}")"
  fi
  alarm ERROR "$BODY" || true
  exit 2
fi

if [[ $OVERALL -eq 0 ]]; then
  echo "[$PROBE] OK: A1-A4 passed on both clusters (dev fzwmnzmtqidumdqjdddz, prod lcdicqalreskibdfxkzb)"
  # Best-effort clear so the next red is never mistaken for a suppressed
  # repeat of stale state. Never turns a clean run into an error.
  printf 'CLEAR|%s\n' "$(date +%s)" > "$STATE_FILE" 2>/dev/null || true
  exit 0
fi

# OVERALL -eq 1: a real, checkable ALARM. Fingerprint it and apply dedup.
SORTED_ALARMS=$(printf '%s\n' "${ALARM_LINES[@]}" | sort)
FINGERPRINT=$(printf '%s' "$SORTED_ALARMS" | sha256sum | cut -c1-16)
BODY="anon ACL invariant violated: $(printf '%s; ' "${ALARM_LINES[@]}")"

OLD_FP=""
OLD_EPOCH=0
if [[ -e "$STATE_FILE" ]]; then
  if ! STATE_CONTENT=$(cat "$STATE_FILE" 2>&1); then
    echo "[$PROBE] ERROR: state file ${STATE_FILE} exists but could not be read: ${STATE_CONTENT}" >&2
    exit 2
  fi
  OLD_FP="${STATE_CONTENT%%|*}"
  OLD_EPOCH="${STATE_CONTENT##*|}"
  [[ "$OLD_EPOCH" =~ ^[0-9]+$ ]] || OLD_EPOCH=0
fi

NOW=$(date +%s)
AGE=$(( NOW - OLD_EPOCH ))

if [[ "$FINGERPRINT" != "$OLD_FP" || $AGE -ge $DEDUP_SECONDS ]]; then
  if ! alarm ALARM "$BODY"; then
    echo "[$PROBE] ERROR: ALARM was real and the page could NOT be delivered; exiting 2 so an undelivered ALARM never reads as a delivered one" >&2
    exit 2
  fi
  if ! printf '%s|%s\n' "$FINGERPRINT" "$NOW" > "$STATE_FILE"; then
    echo "[$PROBE] ERROR: page was delivered but the state file ${STATE_FILE} could not be written; the next run cannot prove this page happened" >&2
    exit 2
  fi
  exit 1
fi

echo "[$PROBE] SUPPRESSED: identical fingerprint (${FINGERPRINT}) already paged $((AGE / 60))m ago, within the ${DEDUP_SECONDS}s dedup window. State file confirmed readable. Not re-paging." >&2
echo "[$PROBE] Still red: $(printf '%s; ' "${ALARM_LINES[@]}")" >&2
exit 1
