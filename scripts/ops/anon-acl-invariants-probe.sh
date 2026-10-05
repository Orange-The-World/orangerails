#!/usr/bin/env bash
# anon-acl-invariants-probe.sh
#
# Guards the anon role's privileges in schema public on BOTH Supabase
# clusters. Default privileges fire again every time a new object is
# created, so a fix to today's grants is a state, not an end: this is what
# tells us if it comes back. Design spec (OR-T1408):
#   https://wiki.orangerails.dev/doc/anon-acl-invariants-scheduled-assertion-design-and-build-spec-or-t1408-OGUgoTmayF
#
# Assertions, run against each cluster independently:
#   A1  zero relations and zero functions in schema public owned by
#       anything other than postgres
#   A2  default ACLs for role postgres in public, ANON ENTRY ONLY: objtype
#       r is exactly SELECT; objtypes S and f name no anon entry at all
#   A3  the set of (relkind, relation, privilege) where anon holds a
#       NON-SELECT privilege in public, ANY relkind, equals EXACTLY
#       (r, adapter_requests, INSERT) and (r, waitlist, INSERT)
#   A4  could-not-check is its own outcome, distinct from both OK and
#       ALARM, and it is never read as a pass
#
# Exit codes (unchanged in meaning from orbi-staleness-probe.sh):
#   0  -- OK: every assertion passed on every cluster in scope
#   1  -- ALARM, and a page was delivered this run, OR an identical
#         failure fingerprint was already paged within the last 24 hours
#         and the state file recording that delivery was readable
#   2  -- ERROR: could not reach a cluster, a query failed, the alert
#         script is unusable, the page could not be delivered, or the
#         dedup state file could not be read or written when a paging
#         decision depended on it. A misconfigured host must never look
#         like a clean cluster, and an undelivered alarm must never read
#         as a delivered one.
#
# Required env:
#   ANON_ACL_PROBE_DSN_DEV    postgres DSN for fzwmnzmtqidumdqjdddz
#   ANON_ACL_PROBE_DSN_PROD   postgres DSN for lcdicqalreskibdfxkzb
#   ORBI_ALERT_SCRIPT         absolute path to the host's shared alert
#                             script, called as "$ORBI_ALERT_SCRIPT" <level>
#                             <body>. Same transport and same contract as
#                             every other probe in this family: one alert
#                             path per host, no second credential block.
#                             Supplied by the systemd unit environment so no
#                             host path lives in this repo. The probe
#                             refuses to start (exit 2) if it is unset,
#                             missing, or not executable.
#   ANON_ACL_PROBE_STATE_FILE absolute path to a small file this probe may
#                             read and write, used only to fingerprint and
#                             dedup a standing ALARM. Not read or required
#                             on a clean (exit 0) run beyond a best-effort
#                             write. Required the moment a page decision is
#                             being made: unreadable or unwritable there is
#                             exit 2, never a silent pass.
#
# Optional env:
#   ANON_ACL_DEDUP_HOURS      hours to suppress a repeat identical page,
#                             default 24
#
# A cluster missing its DSN is reported as that cluster's own ERROR result,
# not a global failure: one cluster being unreachable must never suppress
# the other cluster's result. Both clusters are always attempted and the
# worst outcome wins: any ERROR beats any ALARM beats OK.

set -uo pipefail

PROBE="anon-acl-invariants-probe"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
STATE_FILE="${ANON_ACL_PROBE_STATE_FILE:-}"
DEDUP_HOURS="${ANON_ACL_DEDUP_HOURS:-24}"

# The alert script must be usable BEFORE anything else runs, including
# before either cluster is touched. A probe that can detect a privilege
# escalation and page nobody is the exact defect this whole family exists
# to fix. This exits 2 (ERROR), never 1: a misconfigured host must not look
# like a clean pair of clusters.
if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect an ACL invariant break and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect an ACL invariant break and page nobody" >&2
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

# check_cluster CLUSTER_LABEL DSN
#
# Prints exactly one line to stdout:
#   STATUS<TAB>finding1;;finding2;;...
# STATUS is OK, ALARM or ERROR. On ERROR the single "finding" is the error
# message. All diagnostic chatter goes to stderr so stdout stays parseable.
check_cluster() {
  local label="$1"
  local dsn="$2"

  if [[ -z "$dsn" ]]; then
    printf 'ERROR\t%s\n' "no DSN configured for cluster ${label}"
    return
  fi

  local findings=()

  # ---- A1: ownership precondition ----------------------------------------
  local a1_rel a1_rel_rc
  a1_rel=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
       AND pg_get_userbyid(c.relowner) <> 'postgres'
     ORDER BY 1,2;" 2>&1)
  a1_rel_rc=$?
  if [[ $a1_rel_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: A1 relation-owner query failed (psql exit ${a1_rel_rc}): ${a1_rel}"
    return
  fi
  if [[ -n "$a1_rel" ]]; then
    while IFS='|' read -r relname relkind owner; do
      [[ -z "$relname" ]] && continue
      findings+=("A1: ${label} relkind=${relkind} ${relname} owned by '${owner}', expected postgres")
    done <<< "$a1_rel"
  fi

  local a1_fn a1_fn_rc
  a1_fn=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT p.proname, pg_get_userbyid(p.proowner)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'postgres'
     ORDER BY 1;" 2>&1)
  a1_fn_rc=$?
  if [[ $a1_fn_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: A1 function-owner query failed (psql exit ${a1_fn_rc}): ${a1_fn}"
    return
  fi
  if [[ -n "$a1_fn" ]]; then
    while IFS='|' read -r proname owner; do
      [[ -z "$proname" ]] && continue
      findings+=("A1: ${label} function ${proname} owned by '${owner}', expected postgres")
    done <<< "$a1_fn"
  fi

  # ---- A2: default ACL for role postgres in public, anon entry only ------
  local a2 a2_rc
  a2=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT d.defaclobjtype::text, x.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace,
      LATERAL aclexplode(d.defaclacl) x
      JOIN pg_roles g ON g.oid = x.grantee
     WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres'
       AND g.rolname = 'anon'
     ORDER BY 1,2;" 2>&1)
  a2_rc=$?
  if [[ $a2_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: A2 default-ACL query failed (psql exit ${a2_rc}): ${a2}"
    return
  fi

  # Expected result set: exactly one row, ('r','SELECT'). Anything else,
  # including an empty result, is red -- losing the r/SELECT row silently
  # changes what every new table does.
  local a2_saw_expected_row=0
  if [[ -z "$a2" ]]; then
    findings+=("A2: ${label} default ACL for postgres in public has NO anon entry on objtype r; expected (r,SELECT)")
  else
    while IFS='|' read -r objtype priv; do
      [[ -z "$objtype" ]] && continue
      if [[ "$objtype" == "r" && "$priv" == "SELECT" ]]; then
        a2_saw_expected_row=1
      else
        findings+=("A2: ${label} default ACL for postgres in public grants anon objtype=${objtype} privilege=${priv}, not permitted (only r/SELECT is)")
      fi
    done <<< "$a2"
    if [[ $a2_saw_expected_row -eq 0 ]]; then
      findings+=("A2: ${label} default ACL for postgres in public has no (r,SELECT) row for anon; expected exactly one")
    fi
  fi

  # ---- A3: set-equality on anon non-SELECT privileges, any relkind -------
  local a3 a3_rc
  a3=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT c.relkind::text, c.relname, x.privilege_type
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(c.relacl) x
      JOIN pg_roles g ON g.oid = x.grantee
     WHERE n.nspname = 'public' AND g.rolname = 'anon' AND x.privilege_type <> 'SELECT'
     ORDER BY 1,2,3;" 2>&1)
  a3_rc=$?
  if [[ $a3_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: A3 anon-privilege query failed (psql exit ${a3_rc}): ${a3}"
    return
  fi

  local -A a3_expected=( ["r|adapter_requests|INSERT"]=1 ["r|waitlist|INSERT"]=1 )
  local -A a3_seen=()
  if [[ -n "$a3" ]]; then
    while IFS='|' read -r relkind relname priv; do
      [[ -z "$relkind" ]] && continue
      local key="${relkind}|${relname}|${priv}"
      a3_seen["$key"]=1
      if [[ -z "${a3_expected[$key]:-}" ]]; then
        findings+=("A3: ${label} anon holds unexpected privilege ${priv} on ${relkind}:${relname} (privilege escalation)")
      fi
    done <<< "$a3"
  fi
  local expected_key
  for expected_key in "${!a3_expected[@]}"; do
    if [[ -z "${a3_seen[$expected_key]:-}" ]]; then
      findings+=("A3: ${label} anon is MISSING expected privilege ${expected_key//|/:} (broken public signup form)")
    fi
  done

  if [[ ${#findings[@]} -eq 0 ]]; then
    printf 'OK\t%s\n' "cluster ${label}: A1-A3 all passed"
  else
    local joined
    joined=$(printf '%s;; ' "${findings[@]}")
    printf 'ALARM\t%s\n' "$joined"
  fi
}

# ---- run both clusters, independently ---------------------------------------

WORST=0   # 0 OK, 1 ALARM, 2 ERROR
ALL_FINDINGS=()
REPORT_LINES=()

for pair in "dev|${ANON_ACL_PROBE_DSN_DEV:-}" "prod|${ANON_ACL_PROBE_DSN_PROD:-}"; do
  cluster_label="${pair%%|*}"
  cluster_dsn="${pair#*|}"
  result_line=$(check_cluster "$cluster_label" "$cluster_dsn")
  status="${result_line%%$'\t'*}"
  detail="${result_line#*$'\t'}"

  case "$status" in
    ERROR)
      REPORT_LINES+=("[${cluster_label}] ERROR: ${detail}")
      [[ $WORST -lt 2 ]] && WORST=2
      ;;
    ALARM)
      REPORT_LINES+=("[${cluster_label}] ALARM: ${detail}")
      # detail is already ";; " separated findings for this cluster
      IFS=';;' read -ra cluster_findings <<< "$detail"
      for f in "${cluster_findings[@]}"; do
        f="${f## }"
        [[ -n "$f" ]] && ALL_FINDINGS+=("$f")
      done
      [[ $WORST -lt 1 ]] && WORST=1
      ;;
    OK)
      REPORT_LINES+=("[${cluster_label}] OK: ${detail}")
      ;;
    *)
      REPORT_LINES+=("[${cluster_label}] ERROR: unrecognized probe result '${result_line}'")
      WORST=2
      ;;
  esac
done

FULL_REPORT=$(printf '%s | ' "${REPORT_LINES[@]}")

# ---- worst outcome wins: ERROR (2) beats ALARM (1) beats OK (0) ------------

if [[ $WORST -eq 2 ]]; then
  alarm ERROR "${FULL_REPORT}" || true
  exit 2
fi

if [[ $WORST -eq 0 ]]; then
  echo "[$PROBE] OK: ${FULL_REPORT}"
  # Best-effort only: mark the state file clean so a later alarm with the
  # SAME fingerprint as a stale pre-recovery record still pages immediately.
  # A failure to write here is never fatal -- the clean run is exit 0 either
  # way, and the ALARM path below re-validates the state file itself.
  if [[ -n "$STATE_FILE" ]]; then
    { printf 'CLEAN\n%s\n' "$(date -u +%s)" > "$STATE_FILE"; } 2>/dev/null || true
  fi
  exit 0
fi

# ---- WORST == 1: ALARM. Fingerprint and dedup. ------------------------------
# Fingerprint is cluster plus the sorted offending rows, so a different red
# shape (or a different cluster) is always a different fingerprint, and the
# same shape recurring is the same fingerprint.

SORTED_FINDINGS=$(printf '%s\n' "${ALL_FINDINGS[@]}" | LC_ALL=C sort)
FINGERPRINT=$(printf '%s' "$SORTED_FINDINGS" | sha256sum | awk '{print $1}')

if [[ -z "$STATE_FILE" ]]; then
  echo "[$PROBE] ERROR: ANON_ACL_PROBE_STATE_FILE is not set; cannot prove an identical page was already delivered, so a dedup decision cannot be made safely" >&2
  exit 2
fi

PREV_FINGERPRINT=""
PREV_TS=0
if [[ -e "$STATE_FILE" ]]; then
  if [[ ! -r "$STATE_FILE" ]]; then
    echo "[$PROBE] ERROR: ${STATE_FILE} exists but is not readable; cannot prove an identical page was already delivered" >&2
    exit 2
  fi
  { read -r PREV_FINGERPRINT; read -r PREV_TS; } < "$STATE_FILE" 2>/dev/null || true
  PREV_TS="${PREV_TS:-0}"
  [[ "$PREV_TS" =~ ^[0-9]+$ ]] || PREV_TS=0
fi

NOW=$(date -u +%s)
DEDUP_SECONDS=$(( DEDUP_HOURS * 3600 ))
AGE=$(( NOW - PREV_TS ))

SHOULD_PAGE=1
if [[ "$FINGERPRINT" == "$PREV_FINGERPRINT" && $AGE -lt $DEDUP_SECONDS && $AGE -ge 0 ]]; then
  SHOULD_PAGE=0
fi

if [[ $SHOULD_PAGE -eq 1 ]]; then
  if alarm ALARM "${FULL_REPORT}"; then
    if ! { printf '%s\n%s\n' "$FINGERPRINT" "$NOW" > "$STATE_FILE"; } 2>/dev/null; then
      echo "[$PROBE] ERROR: page was delivered but ${STATE_FILE} could not be written; the next run cannot dedup correctly" >&2
      exit 2
    fi
    exit 1
  else
    echo "[$PROBE] ERROR: ACL invariant ALARM could NOT be delivered; exiting 2 so an undelivered ALARM never reads as a delivered one" >&2
    exit 2
  fi
else
  echo "[$PROBE] SUPPRESSED (dedup): identical fingerprint already paged $(( AGE / 3600 ))h ago, within the ${DEDUP_HOURS}h window. ${FULL_REPORT}"
  exit 1
fi
