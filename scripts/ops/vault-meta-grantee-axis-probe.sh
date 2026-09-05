#!/usr/bin/env bash
# vault-meta-grantee-axis-probe.sh
#
# Standing hourly check of who holds ANY privilege on the two sealed vault
# meta tables (public.user_vault_meta, public.customer_vault_meta), on BOTH
# Supabase clusters. Built for OR-T1539, out of the challenge tracked as
# OR-C0820 (2026-09-02).
#
# WHY THIS EXISTS
# supabase/migrations/20260902213700_assert_vault_meta_grantee_allow_list.sql
# asserts this same allow list, but only ONCE, at apply time, and it is
# VACUOUS on a fresh or restored database: the migration that creates the
# or_agent_reader grants (OR-T1489) is numbered above the
# assertion, so on a from-scratch apply the assertion runs first, finds
# nothing, and passes; the grants are created afterward and nothing checks
# them again. This probe is the standing check that migration's own header
# says does not exist yet.
#
# TWO AXES, because an ACL-only check misses privilege held by MEMBERSHIP:
#   G1  ACL axis: no grantee holds a privilege on either table, at table or
#       column level, outside the allow list (expected_grantees at any
#       level/privilege; or_agent_reader for SELECT, COLUMN level only, on
#       exactly the 22 named (table, column) pairs). Same predicate as the
#       migration's DO block, run here as a SELECT so a red result NAMES the
#       offending row instead of only raising.
#   G2  Membership axis: pg_auth_members for postgres, service_role and
#       or_agent_reader. A role granted MEMBERSHIP in one of these creates NO
#       ACL entry and is invisible to G1, so a member outside the per-cluster
#       expected set is reported directly. Expected sets differ by cluster
#       (measured on OR-T1539, 2026-09-02, re-verified 2026-09-05): dev has
#       authenticator and postgres as members of service_role, plus postgres
#       as a member of or_agent_reader (granted twice, by two different
#       grantors, harmless but real); prod additionally carries
#       cli_login_postgres as a member of postgres, an expired-password login
#       role tracked separately as OR-T1574. It is listed here as EXPECTED so
#       this probe does not re-page a risk that ticket already owns; if
#       OR-T1574 removes that membership, remove it from expected_members()
#       below so its removal is not itself read as new drift.
#   G0  Denominator precondition: both sealed tables must exist in this
#       cluster's catalogue before G1/G2 can mean anything. A cluster missing
#       one is an ERROR (could-not-check), never a silent 1-of-2 pass.
#
# Exit codes, unchanged in meaning from anon-acl-invariants-probe.sh:
#   0  OK: G0, G1 and G2 passed on every cluster in scope
#   1  ALARM, and a page was delivered this run, OR an identical failure
#      fingerprint was already paged within the dedup window
#   2  ERROR: could not reach a cluster, a query failed, the alert script is
#      unusable, the page could not be delivered, or the dedup state file
#      could not be read or written when a paging decision depended on it
#
# Required env:
#   GRANTEE_AXIS_PROBE_DSN_DEV     postgres DSN for fzwmnzmtqidumdqjdddz
#   GRANTEE_AXIS_PROBE_DSN_PROD    postgres DSN for lcdicqalreskibdfxkzb
#   ORBI_ALERT_SCRIPT              same shared alert transport as every other
#                                  probe in this family, called as
#                                  "$ORBI_ALERT_SCRIPT" <level> <body>
#   GRANTEE_AXIS_PROBE_STATE_FILE  small file this probe reads/writes to
#                                  fingerprint and dedup a standing ALARM
#
# Optional env:
#   GRANTEE_AXIS_DEDUP_HOURS       hours to suppress a repeat identical page,
#                                  default 24
#
# A cluster missing its DSN is reported as that cluster's own ERROR, never a
# global failure. Both clusters are always attempted; worst outcome wins:
# ERROR beats ALARM beats OK.

set -uo pipefail

PROBE="vault-meta-grantee-axis-probe"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
STATE_FILE="${GRANTEE_AXIS_PROBE_STATE_FILE:-}"
DEDUP_HOURS="${GRANTEE_AXIS_DEDUP_HOURS:-24}"

# The alert script must be usable BEFORE anything else runs, including
# before either cluster is touched. This exits 2 (ERROR), never 1: a
# misconfigured host must not look like a clean pair of clusters.
if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect a grantee-axis break and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect a grantee-axis break and page nobody" >&2
  exit 2
fi

# The 22 (table, column) pairs or_agent_reader may hold SELECT on. Written
# out, not derived -- see 20260902213700's header for why. Keep this list in
# sync with that migration if it ever changes.
AGENT_READER_COLUMNS="ARRAY[
  'public.user_vault_meta.created_at','public.user_vault_meta.kdf_algorithm',
  'public.user_vault_meta.kdf_params','public.user_vault_meta.kem_public_key',
  'public.user_vault_meta.keyring_epoch','public.user_vault_meta.pqc_key_version',
  'public.user_vault_meta.sig_public_key','public.user_vault_meta.updated_at',
  'public.user_vault_meta.user_id','public.user_vault_meta.vault_key_version',
  'public.user_vault_meta.workspace_key_id','public.customer_vault_meta.created_at',
  'public.customer_vault_meta.customer_id','public.customer_vault_meta.kdf_algorithm',
  'public.customer_vault_meta.kdf_params','public.customer_vault_meta.kem_public_key',
  'public.customer_vault_meta.pqc_key_version','public.customer_vault_meta.sig_public_key',
  'public.customer_vault_meta.updated_at','public.customer_vault_meta.vault_key_version',
  'public.customer_vault_meta.vault_mode','public.customer_vault_meta.workspace_key_id'
]"

alarm() {
  local level="$1"
  local body="$2"
  echo "[$PROBE] $level: $body" >&2
  if ! "$ALERT_SCRIPT" "$level" "$body"; then
    echo "[$PROBE] ALERT DELIVERY FAILED: $ALERT_SCRIPT exited non-zero" >&2
    return 1
  fi
}

# expected_members CLUSTER_LABEL
# Prints "role|member" pairs, one per line, that are NOT drift for that
# cluster. Measured live against both projects on OR-T1539 (2026-09-02,
# re-verified 2026-09-05). Anything else found as a member of postgres,
# service_role or or_agent_reader is reported.
expected_members() {
  local label="$1"
  printf 'service_role|authenticator\n'
  printf 'service_role|postgres\n'
  printf 'or_agent_reader|postgres\n'
  if [[ "$label" == "prod" ]]; then
    # Tracked separately as OR-T1574 (expired-password login role). Listed
    # as expected here so this probe does not duplicate that ticket's alarm.
    printf 'postgres|cli_login_postgres\n'
  fi
}

# check_cluster CLUSTER_LABEL DSN
#
# Prints exactly one line to stdout:  STATUS<TAB>finding1;;finding2;;...
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

  # ---- G0: denominator precondition --------------------------------------
  local g0 g0_rc
  g0=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('user_vault_meta','customer_vault_meta')
     ORDER BY 1;" 2>&1)
  g0_rc=$?
  if [[ $g0_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: G0 table-existence query failed (psql exit ${g0_rc}): ${g0}"
    return
  fi
  local table_count=0
  [[ -n "$g0" ]] && table_count=$(printf '%s\n' "$g0" | grep -c .)
  if [[ "$table_count" -ne 2 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: G0 expected 2 sealed tables, found ${table_count} (${g0//$'\n'/, }); refusing to report a partial G1/G2 as though it were complete"
    return
  fi

  # ---- G1: ACL axis -------------------------------------------------------
  local g1 g1_rc
  g1=$(psql "$dsn" --no-password -t -A -F'|' --command "
    WITH acl AS (
      SELECT t AS obj, 'TABLE'::text AS level, NULL::text AS col,
             c.relowner AS owner_oid, a.grantee AS grantee_oid, a.privilege_type
        FROM unnest(ARRAY['public.user_vault_meta','public.customer_vault_meta']) AS t
        JOIN pg_class c ON c.oid = t::regclass
        CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      UNION ALL
      SELECT t, 'COLUMN', att.attname::text, c.relowner, a.grantee, a.privilege_type
        FROM unnest(ARRAY['public.user_vault_meta','public.customer_vault_meta']) AS t
        JOIN pg_class c ON c.oid = t::regclass
        JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
        CROSS JOIN LATERAL aclexplode(att.attacl) AS a
    )
    SELECT acl.obj || '|' || acl.level || '|' || coalesce(acl.col,'') || '|' || acl.privilege_type || '|' ||
           CASE WHEN acl.grantee_oid = 0 THEN 'PUBLIC'
                ELSE coalesce((SELECT r.rolname FROM pg_roles r WHERE r.oid = acl.grantee_oid), 'role oid ' || acl.grantee_oid::text)
           END
      FROM acl
     WHERE acl.grantee_oid = 0
        OR ( acl.grantee_oid <> acl.owner_oid
             AND NOT EXISTS (
                   SELECT 1 FROM pg_roles r WHERE r.oid = acl.grantee_oid
                    AND (r.rolname = ANY (ARRAY['postgres','service_role','authenticated']) OR r.rolsuper))
             AND NOT EXISTS (
                   SELECT 1 FROM pg_roles r WHERE r.oid = acl.grantee_oid AND r.rolname = 'or_agent_reader'
                    AND acl.level = 'COLUMN' AND acl.privilege_type = 'SELECT'
                    AND (acl.obj || '.' || acl.col) = ANY (${AGENT_READER_COLUMNS})) )
     ORDER BY 1;" 2>&1)
  g1_rc=$?
  if [[ $g1_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: G1 ACL-axis query failed (psql exit ${g1_rc}): ${g1}"
    return
  fi
  if [[ -n "$g1" ]]; then
    while IFS='|' read -r obj level col priv grantee; do
      [[ -z "$obj" ]] && continue
      findings+=("G1: ${label} ${obj} ${level}${col:+ ${col}} ${priv} to ${grantee} (outside allow list)")
    done <<< "$g1"
  fi

  # ---- G2: membership axis ------------------------------------------------
  local g2 g2_rc
  g2=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT r.rolname || '|' || m.rolname
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
     WHERE r.rolname IN ('postgres','service_role','or_agent_reader')
     ORDER BY 1;" 2>&1)
  g2_rc=$?
  if [[ $g2_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: G2 membership-axis query failed (psql exit ${g2_rc}): ${g2}"
    return
  fi
  local -A expected=()
  while IFS='|' read -r role member; do
    [[ -z "$role" ]] && continue
    expected["${role}|${member}"]=1
  done < <(expected_members "$label")
  if [[ -n "$g2" ]]; then
    while IFS='|' read -r role member; do
      [[ -z "$role" ]] && continue
      if [[ -z "${expected[${role}|${member}]:-}" ]]; then
        findings+=("G2: ${label} ${member} is a member of ${role} (unexpected; membership grants everything ${role} holds, with no ACL entry)")
      fi
    done <<< "$g2"
  fi

  if [[ ${#findings[@]} -eq 0 ]]; then
    printf 'OK\t%s\n' "cluster ${label}: 2 of 2 tables present, G1 and G2 both passed"
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

for pair in "dev|${GRANTEE_AXIS_PROBE_DSN_DEV:-}" "prod|${GRANTEE_AXIS_PROBE_DSN_PROD:-}"; do
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

CLUSTERS_OK=0
for line in "${REPORT_LINES[@]}"; do
  [[ "$line" == *"] OK:"* ]] && CLUSTERS_OK=$(( CLUSTERS_OK + 1 ))
done
SUMMARY="checked ${#REPORT_LINES[@]} of 2 clusters, ${CLUSTERS_OK} clean"
FULL_REPORT=$(printf '%s | ' "${REPORT_LINES[@]}")

# ---- worst outcome wins: ERROR (2) beats ALARM (1) beats OK (0) ------------

if [[ $WORST -eq 2 ]]; then
  alarm ERROR "${SUMMARY} | ${FULL_REPORT}" || true
  exit 2
fi

if [[ $WORST -eq 0 ]]; then
  echo "[$PROBE] OK: ${SUMMARY} | ${FULL_REPORT}"
  # Best-effort only: mark the state file clean so a later alarm with the
  # SAME fingerprint as a stale pre-recovery record still pages immediately.
  if [[ -n "$STATE_FILE" ]]; then
    { printf 'CLEAN\n%s\n' "$(date -u +%s)" > "$STATE_FILE"; } 2>/dev/null || true
  fi
  exit 0
fi

# ---- WORST == 1: ALARM. Fingerprint and dedup. ------------------------------

SORTED_FINDINGS=$(printf '%s\n' "${ALL_FINDINGS[@]}" | LC_ALL=C sort)
FINGERPRINT=$(printf '%s' "$SORTED_FINDINGS" | sha256sum | awk '{print $1}')

if [[ -z "$STATE_FILE" ]]; then
  echo "[$PROBE] ERROR: GRANTEE_AXIS_PROBE_STATE_FILE is not set; cannot prove an identical page was already delivered, so a dedup decision cannot be made safely" >&2
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
  if alarm ALARM "${SUMMARY} | ${FULL_REPORT}"; then
    if ! { printf '%s\n%s\n' "$FINGERPRINT" "$NOW" > "$STATE_FILE"; } 2>/dev/null; then
      echo "[$PROBE] ERROR: page was delivered but ${STATE_FILE} could not be written; the next run cannot dedup correctly" >&2
      exit 2
    fi
    exit 1
  else
    echo "[$PROBE] ERROR: grantee-axis ALARM could NOT be delivered; exiting 2 so an undelivered ALARM never reads as a delivered one" >&2
    exit 2
  fi
else
  echo "[$PROBE] SUPPRESSED (dedup): identical fingerprint already paged $(( AGE / 3600 ))h ago, within the ${DEDUP_HOURS}h window. ${SUMMARY} | ${FULL_REPORT}"
  exit 1
fi
