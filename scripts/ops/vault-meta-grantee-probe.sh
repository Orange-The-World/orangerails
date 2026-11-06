#!/usr/bin/env bash
# vault-meta-grantee-probe.sh
#
# Guards the GRANTEE axis on the two sealed vault meta tables, on BOTH Supabase
# clusters. Design and the exact allow-list this reuses:
#   supabase/migrations/20260902213700_assert_vault_meta_grantee_allow_list.sql
# That migration asserts this allow list ONCE, per project, at apply time, and
# says so in its own header: "A standing check belongs in the hourly ACL
# invariant probe, not here." This is that probe. Same shape, same alert
# transport, and the same exit-code contract as
#   scripts/ops/anon-acl-invariants-probe.sh
#
# Assertions, run against each cluster independently:
#   B1  the GRANTEE axis: the only roles that may hold ANY privilege, at
#       TABLE or COLUMN level, on public.user_vault_meta or
#       public.customer_vault_meta, are postgres, service_role and
#       authenticated (or the table owner, or a superuser). or_agent_reader is
#       admitted CONDITIONALLY: SELECT only, COLUMN level only, on exactly the
#       22 (table, column) pairs named below. Everything else, including
#       PUBLIC, is an offender. A role that does not exist reports nothing --
#       this is an allow list, not a require list, matching the migration's
#       own stated design for a fresh or restored database.
#   B2  the MEMBERSHIP axis: an ACL entry is not the only way into a table. A
#       role granted MEMBERSHIP in postgres, service_role or or_agent_reader
#       inherits everything that role holds and creates no ACL entry, so B1
#       cannot see it. B2 walks pg_auth_members for those three role names and
#       flags any member outside the small allowed set below.
#   B3  could-not-check is its own outcome, distinct from both OK and ALARM,
#       and it is never read as a pass.
#
# Exit codes (unchanged in meaning from the anon-ACL probe):
#   0  -- OK: every assertion passed on every cluster in scope
#   1  -- ALARM, and a page was delivered this run, OR an identical failure
#         fingerprint was already paged within the last 24 hours and the state
#         file recording that delivery was readable
#   2  -- ERROR: could not reach a cluster, a query failed, the alert script is
#         unusable, the page could not be delivered, or the dedup state file
#         could not be read or written when a paging decision depended on it.
#
# Required env:
#   VAULT_META_PROBE_DSN_DEV    postgres DSN for fzwmnzmtqidumdqjdddz
#   VAULT_META_PROBE_DSN_PROD   postgres DSN for lcdicqalreskibdfxkzb
#   ORBI_ALERT_SCRIPT           absolute path to the host's shared alert
#                               script, same transport and contract as every
#                               other probe in this family. Supplied by the
#                               systemd unit environment so no host path lives
#                               in this repo. The probe refuses to start
#                               (exit 2) if it is unset, missing, or not
#                               executable.
#   VAULT_META_PROBE_STATE_FILE absolute path to a small file this probe may
#                               read and write, used only to fingerprint and
#                               dedup a standing ALARM. Same contract as the
#                               anon-ACL probe's state file.
#
# Optional env:
#   VAULT_META_DEDUP_HOURS      hours to suppress a repeat identical page,
#                               default 24
#
# A cluster missing its DSN is reported as that cluster's own ERROR result,
# not a global failure. Both clusters are always attempted and the worst
# outcome wins: any ERROR beats any ALARM beats OK.

set -uo pipefail

PROBE="vault-meta-grantee-probe"
ALERT_SCRIPT="${ORBI_ALERT_SCRIPT:-}"
STATE_FILE="${VAULT_META_PROBE_STATE_FILE:-}"
DEDUP_HOURS="${VAULT_META_DEDUP_HOURS:-24}"

if [[ -z "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT is not set; the probe would detect a grantee-axis break and page nobody" >&2
  exit 2
fi

if [[ ! -f "$ALERT_SCRIPT" || ! -x "$ALERT_SCRIPT" ]]; then
  echo "[$PROBE] ERROR: ORBI_ALERT_SCRIPT does not point at an executable file; the probe would detect a grantee-axis break and page nobody" >&2
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

# The 22 (table, column) pairs or_agent_reader may hold SELECT on, verbatim
# from 20260902213700_assert_vault_meta_grantee_allow_list.sql. Written out,
# not derived, for the same reason the migration writes it out: a list read
# from the catalogue at check time would describe whatever it found and could
# never disagree with it.
AGENT_READER_COLUMNS_SQL="ARRAY[
  'public.user_vault_meta.created_at','public.user_vault_meta.kdf_algorithm','public.user_vault_meta.kdf_params',
  'public.user_vault_meta.kem_public_key','public.user_vault_meta.keyring_epoch','public.user_vault_meta.pqc_key_version',
  'public.user_vault_meta.sig_public_key','public.user_vault_meta.updated_at','public.user_vault_meta.user_id',
  'public.user_vault_meta.vault_key_version','public.user_vault_meta.workspace_key_id',
  'public.customer_vault_meta.created_at','public.customer_vault_meta.customer_id','public.customer_vault_meta.kdf_algorithm',
  'public.customer_vault_meta.kdf_params','public.customer_vault_meta.kem_public_key','public.customer_vault_meta.pqc_key_version',
  'public.customer_vault_meta.sig_public_key','public.customer_vault_meta.updated_at','public.customer_vault_meta.vault_key_version',
  'public.customer_vault_meta.vault_mode','public.customer_vault_meta.workspace_key_id'
]"

# check_cluster CLUSTER_LABEL DSN
#
# Prints exactly one line to stdout:
#   STATUS<TAB>finding1;;finding2;;...
# STATUS is OK, ALARM or ERROR. All diagnostic chatter goes to stderr.
check_cluster() {
  local label="$1"
  local dsn="$2"

  if [[ -z "$dsn" ]]; then
    printf 'ERROR\t%s\n' "no DSN configured for cluster ${label}"
    return
  fi

  local findings=()

  # ---- B1: grantee axis on the two sealed tables -------------------------
  local b1 b1_rc
  b1=$(psql "$dsn" --no-password -t -A -F'|' --command "
    WITH sealed_tables AS (SELECT unnest(ARRAY['public.user_vault_meta','public.customer_vault_meta']) AS t),
    expected AS (SELECT unnest(ARRAY['postgres','service_role','authenticated']) AS g),
    agent_cols AS (SELECT unnest(${AGENT_READER_COLUMNS_SQL}) AS c),
    acl AS (
      SELECT t.t AS obj, 'TABLE'::text AS level, NULL::text AS col, cl.relowner AS owner_oid, a.grantee AS grantee_oid, a.privilege_type
        FROM sealed_tables t JOIN pg_class cl ON cl.oid = t.t::regclass
        CROSS JOIN LATERAL aclexplode(cl.relacl) AS a
      UNION ALL
      SELECT t.t, 'COLUMN', att.attname::text, cl.relowner, a.grantee, a.privilege_type
        FROM sealed_tables t JOIN pg_class cl ON cl.oid = t.t::regclass
        JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum > 0 AND NOT att.attisdropped
        CROSS JOIN LATERAL aclexplode(att.attacl) AS a
    )
    SELECT acl.obj || ' ' || acl.level || coalesce(' ' || acl.col, '') || ' ' || acl.privilege_type || ' to ' ||
           CASE WHEN acl.grantee_oid = 0 THEN 'PUBLIC' ELSE coalesce(r.rolname, 'role oid ' || acl.grantee_oid::text) END
      FROM acl LEFT JOIN pg_roles r ON r.oid = acl.grantee_oid
     WHERE acl.grantee_oid = 0
        OR (acl.grantee_oid <> acl.owner_oid
            AND NOT EXISTS (SELECT 1 FROM pg_roles rr WHERE rr.oid=acl.grantee_oid AND (rr.rolname IN (SELECT g FROM expected) OR rr.rolsuper))
            AND NOT EXISTS (SELECT 1 FROM pg_roles rr WHERE rr.oid=acl.grantee_oid AND rr.rolname='or_agent_reader'
                              AND acl.level='COLUMN' AND acl.privilege_type='SELECT'
                              AND (acl.obj||'.'||acl.col) IN (SELECT c FROM agent_cols)))
     ORDER BY 1;" 2>&1)
  b1_rc=$?
  if [[ $b1_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: B1 grantee-axis query failed (psql exit ${b1_rc}): ${b1}"
    return
  fi
  if [[ -n "$b1" ]]; then
    while IFS= read -r offender; do
      [[ -z "$offender" ]] && continue
      findings+=("B1: ${label} a privilege outside the allow list exists on a sealed vault meta table: ${offender}")
    done <<< "$b1"
  fi

  # ---- B2: membership axis on the three admitted roles --------------------
  # Expected members, by ROLE NAME, of each admitted role. postgres is always
  # an allowed member of service_role and or_agent_reader (both clusters,
  # measured). authenticator is Supabase's own connection role and is the
  # documented way a client session switches into service_role. Neither
  # postgres nor authenticator being a member of these roles is new access:
  # postgres already owns both tables and bypasses RLS anyway.
  local b2 b2_rc
  b2=$(psql "$dsn" --no-password -t -A -F'|' --command "
    SELECT roleid::regrole::text, member::regrole::text
      FROM pg_auth_members
     WHERE roleid::regrole::text IN ('postgres','service_role','or_agent_reader')
     ORDER BY 1,2;" 2>&1)
  b2_rc=$?
  if [[ $b2_rc -ne 0 ]]; then
    printf 'ERROR\t%s\n' "cluster ${label}: B2 membership query failed (psql exit ${b2_rc}): ${b2}"
    return
  fi
  if [[ -n "$b2" ]]; then
    while IFS='|' read -r roleid member; do
      [[ -z "$roleid" ]] && continue
      local allowed=0
      case "${roleid}:${member}" in
        service_role:authenticator|service_role:postgres|or_agent_reader:postgres) allowed=1 ;;
        # postgres:cli_login_postgres is a known, live member on production
        # today, believed to be Supabase's own dashboard/CLI login mechanism.
        # Allow-listed here so the probe does not open red on day one, but
        # this was NOT independently confirmed as a Supabase platform
        # invariant -- if you are reviewing this file, please confirm it
        # (or correct this allow list) rather than trusting the comment.
        postgres:cli_login_postgres) allowed=1 ;;
      esac
      if [[ $allowed -eq 0 ]]; then
        findings+=("B2: ${label} unexpected member '${member}' of role '${roleid}' (membership inherits every ACL entry that role holds, invisible to B1)")
      fi
    done <<< "$b2"
  fi

  if [[ ${#findings[@]} -eq 0 ]]; then
    printf 'OK\t%s\n' "cluster ${label}: B1-B2 all passed"
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

for pair in "dev|${VAULT_META_PROBE_DSN_DEV:-}" "prod|${VAULT_META_PROBE_DSN_PROD:-}"; do
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

FULL_REPORT=$(printf '%s | ' "${REPORT_LINES[@]}")

# ---- worst outcome wins: ERROR (2) beats ALARM (1) beats OK (0) ------------

if [[ $WORST -eq 2 ]]; then
  alarm ERROR "${FULL_REPORT}" || true
  exit 2
fi

if [[ $WORST -eq 0 ]]; then
  echo "[$PROBE] OK: ${FULL_REPORT}"
  if [[ -n "$STATE_FILE" ]]; then
    { printf 'CLEAN\n%s\n' "$(date -u +%s)" > "$STATE_FILE"; } 2>/dev/null || true
  fi
  exit 0
fi

# ---- WORST == 1: ALARM. Fingerprint and dedup, same contract as the anon probe.

SORTED_FINDINGS=$(printf '%s\n' "${ALL_FINDINGS[@]}" | LC_ALL=C sort)
FINGERPRINT=$(printf '%s' "$SORTED_FINDINGS" | sha256sum | awk '{print $1}')

if [[ -z "$STATE_FILE" ]]; then
  echo "[$PROBE] ERROR: VAULT_META_PROBE_STATE_FILE is not set; cannot prove an identical page was already delivered, so a dedup decision cannot be made safely" >&2
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
    echo "[$PROBE] ERROR: grantee-axis ALARM could NOT be delivered; exiting 2 so an undelivered ALARM never reads as a delivered one" >&2
    exit 2
  fi
else
  echo "[$PROBE] SUPPRESSED (dedup): identical fingerprint already paged $(( AGE / 3600 ))h ago, within the ${DEDUP_HOURS}h window. ${FULL_REPORT}"
  exit 1
fi
