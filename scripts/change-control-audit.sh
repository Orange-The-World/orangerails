#!/usr/bin/env bash
#
# Read the repository settings that gate production changes, record one normalized
# reading, and compare it against the previous reading.
#
# WHY THIS EXISTS
#   The settings that gate production database changes were changed on one day and
#   nobody noticed for seven days. In that window a risk ticket was closed by quoting
#   the pre-change values as current. Nothing was harmed. The point is that nothing
#   would have told us if it had been.
#
# WHAT IT READS (GET only, never a write endpoint)
#   GET /repos/<repo>/environments        protection rules, reviewer lists,
#                                         prevent_self_review, can_admins_bypass
#   GET /repos/<repo>/actions/variables   only variables whose name begins with
#                                         MIGRATION_APPLY_ALLOWED_ACTORS
#
#   The variable filter is deliberate and is a safety boundary, not tidiness. This
#   repository is public, so anything this script records ends up readable by anyone.
#   The actor allowlists hold GitHub account names that already appear publicly on
#   this repository's commits and pull requests, so recording them publishes nothing
#   new. A variable holding anything else must never be copied here, and the prefix
#   filter is what guarantees that even if someone adds one later.
#
# THREE OUTCOMES, deliberately three different exit codes
#   0  the read succeeded and nothing changed, or this is the first reading
#   1  the read succeeded and something CHANGED. Old and new values are named.
#   2  the read itself FAILED, or an expected value was missing. NO comparison was
#      made and no verdict is implied. "I could not look" must never be
#      indistinguishable from "nothing changed": that is the exact failure this
#      whole check exists to remove.
#
# ENVIRONMENT
#   REPO                 owner/name. Defaults to GITHUB_REPOSITORY.
#   READING_OUT          where to write the reading. Default ./reading.json
#   PREV_READING         path to the previous reading. Empty or missing means this
#                        is a baseline run and no drift claim is made.
#   SIMULATE_UNREADABLE  true points the variables read at a path that cannot be
#                        read, so the loud failure path can be demonstrated.
#   SIMULATE_CHANGE      true alters the PREVIOUS reading IN MEMORY so the alarm can
#                        be seen firing. It never touches a repository setting and
#                        never writes to the previous file.
#   FIXTURE_ENVS         read the environments response from this file instead of
#   FIXTURE_VARS         the API. Used by the self test so it is deterministic.
#
# It requires gh (present on GitHub hosted runners) and jq.

set -uo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
READING_OUT="${READING_OUT:-reading.json}"
PREV_READING="${PREV_READING:-}"
SIMULATE_UNREADABLE="${SIMULATE_UNREADABLE:-false}"
SIMULATE_CHANGE="${SIMULATE_CHANGE:-false}"
FIXTURE_ENVS="${FIXTURE_ENVS:-}"
FIXTURE_VARS="${FIXTURE_VARS:-}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

EXPECTED_VARS="MIGRATION_APPLY_ALLOWED_ACTORS_PROD MIGRATION_APPLY_ALLOWED_ACTORS_DEV"
VAR_PREFIX="MIGRATION_APPLY_ALLOWED_ACTORS"

if [ -z "$REPO" ]; then
  echo "REPO (or GITHUB_REPOSITORY) is not set. Refusing to guess which repository to read." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say () {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >> "$SUMMARY"
}

fail_unreadable () {
  {
    printf '\n## Change control audit: COULD NOT READ\n\n'
    printf 'UNREADABLE: %s\n\n' "$1"
    printf 'This run made no comparison and reached no verdict. It is NOT a statement that\n'
    printf 'nothing changed. Treat it as the check being down, not as a clean result.\n\n'
    printf '```\n%s\n```\n' "$2"
  } >> "$SUMMARY"
  printf '::error::UNREADABLE: %s. No comparison was made.\n' "$1"
  printf 'UNREADABLE: %s\n%s\n' "$1" "$2" >&2
  exit 2
}

READ_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ENV_PATH="repos/${REPO}/environments?per_page=100"
VAR_PATH="repos/${REPO}/actions/variables?per_page=100"
if [ "$SIMULATE_UNREADABLE" = "true" ]; then
  VAR_PATH="repos/${REPO}/actions/variables-this-path-cannot-be-read"
  say "SIMULATION: the variables read has been pointed at a path that cannot be read, to demonstrate the loud failure path."
fi

# ---- read the environments half -------------------------------------------------
if [ -n "$FIXTURE_ENVS" ]; then
  cp "$FIXTURE_ENVS" "$WORK/envs.json" || fail_unreadable "fixture $FIXTURE_ENVS could not be read" "cp failed"
else
  if ! ENVS_RAW="$(gh api "$ENV_PATH" 2>&1)"; then
    fail_unreadable "GET /${ENV_PATH}" "$ENVS_RAW"
  fi
  printf '%s' "$ENVS_RAW" > "$WORK/envs.json"
fi

# ---- read the variables half ----------------------------------------------------
if [ -n "$FIXTURE_VARS" ] && [ "$SIMULATE_UNREADABLE" != "true" ]; then
  cp "$FIXTURE_VARS" "$WORK/vars.json" || fail_unreadable "fixture $FIXTURE_VARS could not be read" "cp failed"
else
  if ! VARS_RAW="$(gh api "$VAR_PATH" 2>&1)"; then
    fail_unreadable "GET /${VAR_PATH}" "$VARS_RAW"
  fi
  printf '%s' "$VARS_RAW" > "$WORK/vars.json"
fi

for half in envs vars; do
  if ! jq -e . "$WORK/${half}.json" >/dev/null 2>&1; then
    fail_unreadable "the ${half} response was not JSON" "$(head -c 400 "$WORK/${half}.json")"
  fi
done

# ---- build one normalized reading ----------------------------------------------
# Only the fields that carry meaning are kept, and every list is sorted, so the
# comparison cannot flip on an id, a node_id or a field GitHub reorders.
jq -S -s \
  --arg read_at "$READ_AT" \
  --arg repo "$REPO" \
  --arg prefix "$VAR_PREFIX" '
  {
    repo: $repo,
    read_at: $read_at,
    environments: ([ .[0].environments[]? | {
        name: .name,
        can_admins_bypass: .can_admins_bypass,
        deployment_branch_policy: .deployment_branch_policy,
        protection_rules: ([ .protection_rules[]? | {
            type: .type,
            wait_timer: (.wait_timer // null),
            prevent_self_review: (.prevent_self_review // null),
            reviewers: ([ (.reviewers // [])[] | {
                type: .type,
                name: (.reviewer.login // .reviewer.slug // "unknown")
            } ] | sort_by(.type, .name))
        } ] | sort_by(.type))
    } ] | sort_by(.name)),
    variables: ([ .[1].variables[]?
                  | select(.name | startswith($prefix))
                  | { name: .name, value: .value } ] | sort_by(.name))
  }' "$WORK/envs.json" "$WORK/vars.json" > "$READING_OUT"

if [ ! -s "$READING_OUT" ]; then
  fail_unreadable "the reading could not be assembled" "jq produced no output from the two responses"
fi

# An empty or filtered-away variables list must NOT read as "the allowlist is fine".
for v in $EXPECTED_VARS; do
  present="$(jq -r --arg n "$v" '[.variables[] | select(.name == $n)] | length' "$READING_OUT")"
  if [ "$present" != "1" ]; then
    fail_unreadable "expected variable ${v} is not present in the reading" \
"Either the variable was deleted, or the token this run used cannot read repository
variables and the API returned a list without it. Both need a human to look. Neither
is a clean result, so this run refuses to record one."
  fi
done

# ---- compare against the previous reading --------------------------------------
jq -S 'del(.read_at)' "$READING_OUT" > "$WORK/new.norm.json"

if [ -z "$PREV_READING" ] || [ ! -f "$PREV_READING" ]; then
  say "## Change control audit: first reading recorded"
  say ""
  say "- repository: ${REPO}"
  say "- read at (UTC): ${READ_AT}"
  say "- there is no previous reading to compare against, so this run records a baseline and makes no claim about drift."
  exit 0
fi

jq -S 'del(.read_at)' "$PREV_READING" > "$WORK/prev.norm.json" 2>/dev/null
if [ ! -s "$WORK/prev.norm.json" ]; then
  fail_unreadable "the previous reading at ${PREV_READING} could not be parsed" "$(head -c 400 "$PREV_READING")"
fi
PREV_READ_AT="$(jq -r '.read_at // "unknown"' "$PREV_READING")"

if [ "$SIMULATE_CHANGE" = "true" ]; then
  jq -S '(.variables[]? | select(.name == "MIGRATION_APPLY_ALLOWED_ACTORS_PROD") | .value)
         |= "the-value-as-it-was-before-this-simulated-change"' \
     "$WORK/prev.norm.json" > "$WORK/prev.sim.json"
  mv "$WORK/prev.sim.json" "$WORK/prev.norm.json"
  say "SIMULATION: the PREVIOUS reading was altered in memory so the alarm can be seen firing. No repository setting and no committed file was touched."
fi

if diff -u "$WORK/prev.norm.json" "$WORK/new.norm.json" > "$WORK/drift.diff"; then
  say "## Change control audit: no change"
  say ""
  say "- repository: ${REPO}"
  say "- previous reading read at (UTC): ${PREV_READ_AT}"
  say "- this reading read at (UTC): ${READ_AT}"
  exit 0
fi

{
  printf '\n## Change control settings CHANGED\n\n'
  printf -- '- repository: %s\n' "$REPO"
  printf -- '- previous reading read at (UTC): %s\n' "$PREV_READ_AT"
  printf -- '- this reading read at (UTC): %s\n\n' "$READ_AT"
  printf '### The values, old and new\n\n'
} >> "$SUMMARY"

for v in $EXPECTED_VARS; do
  old="$(jq -r --arg n "$v" '([.variables[] | select(.name == $n) | .value] | first) // "(absent)"' "$WORK/prev.norm.json")"
  new="$(jq -r --arg n "$v" '([.variables[] | select(.name == $n) | .value] | first) // "(absent)"' "$WORK/new.norm.json")"
  if [ "$old" != "$new" ]; then
    say "- ${v}: OLD [${old}] NEW [${new}]"
  fi
done

ENV_NAMES="$(jq -r '.environments[].name' "$WORK/prev.norm.json" "$WORK/new.norm.json" | sort -u)"
for e in $ENV_NAMES; do
  old="$(jq -c --arg e "$e" '([.environments[] | select(.name == $e)] | first) // "(absent)"' "$WORK/prev.norm.json")"
  new="$(jq -c --arg e "$e" '([.environments[] | select(.name == $e)] | first) // "(absent)"' "$WORK/new.norm.json")"
  if [ "$old" != "$new" ]; then
    say "- environment ${e} OLD: ${old}"
    say "- environment ${e} NEW: ${new}"
  fi
done

{
  printf '\n### The full difference\n\n'
  printf '```diff\n'
  cat "$WORK/drift.diff"
  printf '```\n'
} >> "$SUMMARY"

printf '::error::Change control settings changed since the previous reading. The old and new values are in the job summary.\n'
exit 1
