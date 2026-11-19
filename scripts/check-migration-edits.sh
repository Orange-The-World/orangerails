#!/usr/bin/env bash
#
# Refuse a pull request that changes an existing migration in place.
#
# Reads git name-status lines on stdin, one per changed path, status and path
# separated by a tab:
#
#     A<TAB>supabase/migrations/20260101000000_add_thing.sql
#     M<TAB>supabase/migrations/20260101000000_add_thing.sql
#
# Reads the pull request description from PR_BODY, which may be empty or unset.
#
# Exit codes, and note that only 0 is a pass:
#   0  nothing to refuse, or every changed migration carries its own acknowledgement
#   1  refused. The output names every file and says how to clear it.
#   2  could not decide, because a line of input did not parse. Never a pass.
#
set -euo pipefail

MIGRATION_PREFIX="supabase/migrations/"
ACK_PREFIX="MIGRATION-EDIT-ACK:"

body="${PR_BODY-}"

total=0
migration_paths=0
added=0
offender_paths=()
offender_codes=()

# Is this exact path named on its own acknowledgement line in the description?
# A reason may follow the path on the same line. Backticks, quotes and asterisks
# are stripped so that a path pasted as code or inside bold still matches, and
# carriage returns are stripped because a description written through the web
# interface arrives with them.
ack_present() {
  local want="$1" line rest token
  while IFS= read -r line; do
    case "$line" in
      *"$ACK_PREFIX"*) ;;
      *) continue ;;
    esac
    rest="${line#*"$ACK_PREFIX"}"
    rest="$(printf '%s' "$rest" | tr -d '`"*' | tr -d '\r')"
    read -r token _ <<<"$rest" || true
    if [ "${token-}" = "$want" ]; then
      return 0
    fi
  done <<<"$body"
  return 1
}

while IFS= read -r line || [ -n "$line" ]; do
  if [ -z "$line" ]; then
    continue
  fi
  status="${line%%$'\t'*}"
  path="${line#*$'\t'}"
  if [ "$status" = "$line" ] || [ -z "$status" ] || [ -z "$path" ]; then
    echo "Could not parse this line of the diff: [${line}]"
    echo "Expected a git name-status line: a status, a tab, then a path."
    echo "Refusing to guess. This is exit 2, which is not a pass."
    echo "::error::migration edit guard could not read the diff, so it decided nothing."
    exit 2
  fi
  total=$((total + 1))
  case "$path" in
    "${MIGRATION_PREFIX}"*.sql) ;;
    *) continue ;;
  esac
  migration_paths=$((migration_paths + 1))
  code="${status:0:1}"
  if [ "$code" = "A" ]; then
    added=$((added + 1))
    continue
  fi
  offender_paths+=("$path")
  offender_codes+=("$code")
done

# Say what was actually examined. A check that cannot tell you how much it looked
# at cannot tell you anything: it is the difference between having done the work
# and having merely finished.
echo "Examined ${total} changed path(s): ${migration_paths} under ${MIGRATION_PREFIX}, of which ${added} added and ${#offender_paths[@]} changed some other way."

if [ "${#offender_paths[@]}" -eq 0 ]; then
  echo "PASS: this pull request adds migrations, it does not change existing ones."
  exit 0
fi

unacknowledged=()
acknowledged=()
i=0
while [ "$i" -lt "${#offender_paths[@]}" ]; do
  if ack_present "${offender_paths[$i]}"; then
    acknowledged+=("${offender_codes[$i]}  ${offender_paths[$i]}")
  else
    unacknowledged+=("${offender_codes[$i]}  ${offender_paths[$i]}")
  fi
  i=$((i + 1))
done

if [ "${#acknowledged[@]}" -gt 0 ]; then
  echo ""
  echo "Acknowledged in the pull request description, so not refused:"
  printf '  %s\n' "${acknowledged[@]}"
fi

if [ "${#unacknowledged[@]}" -eq 0 ]; then
  echo ""
  echo "PASS: every changed migration is acknowledged in the description."
  echo "Whoever reviews this is being asked to check that none of those versions has applied anywhere yet."
  exit 0
fi

cat <<'WHY'

REFUSED: this pull request changes a migration that already exists on the base branch.

Why that is refused rather than merely noted
  The apply loop skips any migration whose version is already recorded in the
  ledger, and the name comparison sees the recorded name and the file name and
  finds them identical. So a file edited in place is skipped and passes: the new
  SQL never runs on a cluster that already applied the old SQL, and the two
  clusters end up holding different schemas with every check still green.
WHY

echo ""
echo "Changed rather than added, and not acknowledged:"
printf '  %s\n' "${unacknowledged[@]}"

cat <<'HOW'

How to clear this, when the edit is the right thing to do
  Editing a migration that has not applied on any cluster yet is legitimate and
  common. This check does not decide that for you and cannot: it has no database
  access on purpose. It only asks that somebody says out loud that they know
  they are editing a migration rather than adding one.

  Add one line to the pull request DESCRIPTION for each file listed above:
HOW

for p in "${unacknowledged[@]}"; do
  echo "      MIGRATION-EDIT-ACK: ${p#*  }"
done

cat <<'TAIL'

  Save the description and this check runs again on its own. A reason may follow
  the path on the same line, and it is worth writing one.

  Before you write that line, confirm the version has not applied anywhere. If it
  has already applied, editing the file will never reach that cluster no matter
  what this description says. Write a NEW migration with a new version instead.
TAIL

echo "::error::A migration is changed rather than added, and the pull request description does not acknowledge it. See the step log for which files and how to clear it."
exit 1
