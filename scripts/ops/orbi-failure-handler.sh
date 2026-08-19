#!/usr/bin/env bash
# orbi-failure-handler.sh
#
# OnFailure= handler for orbi-* units. systemd starts this when any orbi
# unit enters the failed state: a crash, a missing binary, a signal, a
# timeout, or any other path where the unit could not report for itself.
#
# Called as: orbi-failure-handler.sh <failed-unit-name>
#
# Required environment (set via EnvironmentFile):
#   ORBI_ALERT_ORG           Zulip org slug for team-post (e.g. orangerails)
#   ORBI_ALERT_STREAM        Zulip stream name
#   ORBI_ALERT_TOPIC         Zulip topic
#   ORBI_ALERT_NUDGE_AGENT   agent name to nudge after delivery (e.g. orbi)
#   ORBI_TEAM_POST_BIN       absolute path to the team-post binary
#
# Optional environment:
#   ORBI_NUDGE_BIN           absolute path to the nudge binary; if unset or
#                            not executable, the alert is still delivered but
#                            the agent is not immediately flushed
#
# Exit codes:
#   0  -- alarm delivered (team-post returned "OK id=...", nudge attempted)
#   3  -- required environment variable(s) unset or team-post binary missing
#   4  -- team-post ran but did not return "OK id=..." (alarm NOT delivered)
#
# WHY team-post instead of a direct Zulip bot call:
#   The bot is subject to a per-window message budget. When that budget is
#   exhausted the API returns HTTP 200 OK but the message is quietly dropped.
#   A handler that sees 200 OK and exits 0 while delivering nothing is the
#   exact defect it exists to catch. team-post relays through chief-of-staff-
#   bot which is SEAT_BUDGET_EXEMPT and actually buffers the message.
#   Calling nudge after a confirmed delivery forces an immediate flush rather
#   than waiting for the agent's next poll cycle.
#
# This script never uses "|| true" on the delivery path. A handler that
# swallows its own failure is the defect it exists to catch; a delivery
# failure must land in the journal with a non-zero exit that systemctl
# is-failed can see.
#
# No binary path is hardcoded in source. This repo is public and the pre-
# publish hygiene scan blocks internal host paths. Supply all paths via the
# EnvironmentFile so the on-box operator controls them.

set -uo pipefail

HANDLER="orbi-failure-handler"

sanitize() {
  printf '%s' "${1:-}" | tr -d '\000-\037' | tr -d '"\\' | cut -c1-200
}

UNIT="$(sanitize "${1:-unknown.service}")"
UNIT="${UNIT:-unknown.service}"
HOST="$(sanitize "$(hostname -s 2>/dev/null || echo unknown-host)")"
HOST="${HOST:-unknown-host}"

BODY="ALARM: ${UNIT} entered the failed state on ${HOST}. Diagnose: journalctl -u ${UNIT} -n 50 --no-pager"

echo "[${HANDLER}] ${BODY}" >&2

# --- validate required env vars ---

MISSING=0
for VAR in ORBI_ALERT_ORG ORBI_ALERT_STREAM ORBI_ALERT_TOPIC ORBI_ALERT_NUDGE_AGENT ORBI_TEAM_POST_BIN; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "[${HANDLER}] ${VAR} is unset in EnvironmentFile; alarm NOT delivered for ${UNIT}" >&2
    MISSING=1
  fi
done
[[ "${MISSING}" -eq 1 ]] && exit 3

if [[ ! -x "${ORBI_TEAM_POST_BIN}" ]]; then
  echo "[${HANDLER}] team-post not found or not executable at ${ORBI_TEAM_POST_BIN}; alarm NOT delivered for ${UNIT}" >&2
  exit 3
fi

# --- deliver the alert via team-post (budget-exempt relay) ---

RESULT="$(printf '%s' "${BODY}" | \
  "${ORBI_TEAM_POST_BIN}" "${ORBI_ALERT_ORG}" "${ORBI_ALERT_STREAM}" "${ORBI_ALERT_TOPIC}" 2>&1)"
echo "[${HANDLER}] team-post output: ${RESULT}" >&2

if ! printf '%s' "${RESULT}" | grep -q 'OK id='; then
  echo "[${HANDLER}] team-post did not return OK id=... ; alarm NOT delivered for ${UNIT}" >&2
  exit 4
fi

echo "[${HANDLER}] alarm delivered for ${UNIT}: ${RESULT}"

# --- nudge the agent to flush immediately ---

NUDGE_BIN="${ORBI_NUDGE_BIN:-}"
if [[ -n "${NUDGE_BIN}" && -x "${NUDGE_BIN}" ]]; then
  if "${NUDGE_BIN}" "${ORBI_ALERT_NUDGE_AGENT}" "${ORBI_ALERT_ORG}" >&2; then
    echo "[${HANDLER}] nudge sent to ${ORBI_ALERT_NUDGE_AGENT} in ${ORBI_ALERT_ORG}" >&2
  else
    echo "[${HANDLER}] nudge exited non-zero; alert was delivered but flush may be delayed" >&2
  fi
else
  echo "[${HANDLER}] ORBI_NUDGE_BIN unset or not executable; alert was delivered but flush not triggered" >&2
fi

exit 0
