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
#   3  -- no alarm transport configured (ZULIP_ALARM_URL / ZULIP_ALARM_KEY unset)
#   4  -- alarm transport unreachable or rejected the message
#
# This script never uses `|| true`. A handler that swallows its own failure is
# the exact defect it exists to catch, so a delivery failure must land in the
# journal with a non-zero exit that `systemctl is-failed` can see.
#
# Environment (shared with orbi-staleness-probe.sh, same EnvironmentFile):
#   ZULIP_ALARM_URL   webhook endpoint
#   ZULIP_ALARM_KEY   bearer token for that endpoint
#   ZULIP_ALARM_TO    destination stream:topic, default Delivery|orbi-staleness-probe

set -uo pipefail

HANDLER="orbi-probe-failed"
UNIT="${1:-unknown.service}"
HOST="$(hostname -s 2>/dev/null || echo unknown-host)"
BODY="ALARM: ${UNIT} entered the failed state on ${HOST}. The probe could not report for itself. Read: journalctl -u ${UNIT} -n 50 --no-pager"

echo "[${HANDLER}] ${BODY}" >&2

if [[ -z "${ZULIP_ALARM_URL:-}" || -z "${ZULIP_ALARM_KEY:-}" ]]; then
  echo "[${HANDLER}] ZULIP_ALARM_URL or ZULIP_ALARM_KEY is unset; alarm NOT delivered for ${UNIT}" >&2
  exit 3
fi

TO="${ZULIP_ALARM_TO:-Delivery|orbi-staleness-probe}"

if ! curl -sS -f -o /dev/null --max-time 15 \
  -H "Authorization: Bearer ${ZULIP_ALARM_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"${TO}\",\"level\":\"ERROR\",\"body\":\"${BODY}\"}" \
  "${ZULIP_ALARM_URL}"; then
  echo "[${HANDLER}] alarm delivery FAILED for ${UNIT}" >&2
  exit 4
fi

echo "[${HANDLER}] alarm delivered for ${UNIT}"
exit 0
