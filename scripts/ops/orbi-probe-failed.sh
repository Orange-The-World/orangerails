#!/usr/bin/env bash
# orbi-probe-failed.sh
#
# OnFailure= handler for the ORBI probe units. systemd starts this when a probe
# unit itself enters the failed state: a crash, a missing binary, a bad
# EnvironmentFile, a signal, a timeout, or any other path where the probe could
# not report for itself.
#
# Called as: orbi-probe-failed.sh <failed-unit-name>
#
# Exit codes:
#   0  -- alarm delivered
#   3  -- no alarm transport available (ORBI_ALERT_SCRIPT unset, or the script
#         it names is missing or not executable)
#   4  -- the alert script ran and failed, so the alarm was not delivered
#
# This script never uses `|| true`. A handler that swallows its own failure is
# the exact defect it exists to catch, so a delivery failure must land in the
# journal with a non-zero exit that `systemctl is-failed` can see.
#
# Transport: the SAME alert script the staleness probe uses, with the same
# (level, body) argument contract. There is one alert path on this host and no
# second credential block. Its location is host configuration, supplied by the
# shared EnvironmentFile as:
#
#   ORBI_ALERT_SCRIPT   absolute path to the shared alert script
#
# It is not defaulted to a literal path in source on purpose: this repo is
# public and the pre-publish hygiene scan blocks internal host paths.

set -uo pipefail

HANDLER="orbi-probe-failed"

# Strip anything that could corrupt a downstream payload (control characters,
# quotes, backslashes) and cap the length. The handler must never be the reason
# an alarm is rejected.
sanitize() {
  printf '%s' "${1:-}" | tr -d '\000-\037' | tr -d '"\\' | cut -c1-200
}

UNIT="$(sanitize "${1:-unknown.service}")"
UNIT="${UNIT:-unknown.service}"
HOST="$(sanitize "$(hostname -s 2>/dev/null || echo unknown-host)")"
HOST="${HOST:-unknown-host}"

BODY="ALARM: ${UNIT} entered the failed state on ${HOST}. The probe could not report for itself. Read: journalctl -u ${UNIT} -n 50 --no-pager"

echo "[${HANDLER}] ${BODY}" >&2

ALERT="${ORBI_ALERT_SCRIPT:-}"

if [[ -z "${ALERT}" ]]; then
  echo "[${HANDLER}] ORBI_ALERT_SCRIPT is unset in the probe EnvironmentFile; alarm NOT delivered for ${UNIT}" >&2
  exit 3
fi

if [[ ! -x "${ALERT}" ]]; then
  echo "[${HANDLER}] alert script named by ORBI_ALERT_SCRIPT is missing or not executable; alarm NOT delivered for ${UNIT}" >&2
  exit 3
fi

if ! "${ALERT}" ERROR "${BODY}"; then
  echo "[${HANDLER}] alarm delivery FAILED for ${UNIT}" >&2
  exit 4
fi

echo "[${HANDLER}] alarm delivered for ${UNIT}"
exit 0
