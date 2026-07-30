#!/usr/bin/env bash
# orbi-forward-fill-liveness.sh
#
# Checks that orbi-forward-fill.service is active.
# Exit codes (see STALENESS_PROBE_CRON.md for the full spec):
#   0  -- service is active
#   1  -- service is in any other state (inactive, failed, activating, ...)
#
# Optional env:
#   SERVICE          systemd unit to check; default orbi-forward-fill.service
#   SYSTEMCTL_BIN    path to systemctl binary; default systemctl
#                    Override in CI: SYSTEMCTL_BIN=./scripts/ops/tests/mock-systemctl.sh
#   MOCK_STATE       when using the mock, the state it returns (default inactive)
#   ZULIP_ALARM_URL  webhook endpoint (alarm fires only when set)
#   ZULIP_ALARM_KEY  bearer token for that endpoint
#   ZULIP_ALARM_TO   destination stream:topic for alarm message

set -uo pipefail

PROBE="orbi-forward-fill-liveness"
SERVICE="${SERVICE:-orbi-forward-fill.service}"
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"

# ---- helpers ----------------------------------------------------------------

alarm() {
  local level="$1"
  local body="$2"
  echo "[$PROBE] $level: $body" >&2
  if [[ -n "${ZULIP_ALARM_URL:-}" && -n "${ZULIP_ALARM_KEY:-}" ]]; then
    local to="${ZULIP_ALARM_TO:-Delivery|orbi-forward-fill-liveness}"
    curl -s -o /dev/null \
      -H "Authorization: Bearer ${ZULIP_ALARM_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"to\":\"${to}\",\"level\":\"${level}\",\"body\":\"${body}\"}" \
      "${ZULIP_ALARM_URL}" || true
  fi
}

# ---- query ------------------------------------------------------------------

STATE=$("$SYSTEMCTL" is-active "$SERVICE" 2>&1 || true)
STATE="${STATE//[[:space:]]/}"

if [[ "$STATE" != "active" ]]; then
  alarm NOT_ACTIVE "${SERVICE} state is '${STATE}' (expected 'active')"
  exit 1
fi

echo "[$PROBE] OK: ${SERVICE} is active"
exit 0
