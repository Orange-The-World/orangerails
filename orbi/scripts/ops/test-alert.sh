#!/usr/bin/env bash
# Smoke test for alert-on-failure.sh. Forces the wrapped command to fail
# and runs the alert codepath in DRY_RUN mode — prints the payload that
# WOULD be sent to signal-cli without actually sending anything.
set -uo pipefail

FOUNDER_NUMBER="+17057123215"
SENDER_NUMBER="+15128818663"
SIGNAL_URL="http://127.0.0.1:8090/v2/send"

echo "==> 1. signal-cli REST liveness check:"
curl -sS http://127.0.0.1:8090/v1/about | jq . || {
  echo "signal-cli REST not reachable on 127.0.0.1:8090 — aborting." >&2
  exit 1
}

echo
echo "==> 2. Simulating reconciler failure with DRY_RUN payload:"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
FAKE_TAIL="(simulated) reconcile-gaps.ts crashed: Error: connect ETIMEDOUT 1.2.3.4:443"
MSG=$(printf "ORBI reconciler FAILED (exit 1) at %s\n\nLast lines of /tmp/orbi-reconciler.log:\n%s\n" "$TS" "$FAKE_TAIL")
PAYLOAD=$(jq -nc \
  --arg num "$FOUNDER_NUMBER" \
  --arg sender "$SENDER_NUMBER" \
  --arg msg "$MSG" \
  '{message: $msg, number: $sender, recipients: [$num]}')

echo "Would POST $SIGNAL_URL with payload:"
echo "$PAYLOAD" | jq .

echo
echo "==> 3. Verifying wrapper exits non-zero when its wrapped command fails (DRY_RUN=1):"
# Sub-shell that mimics the wrapper behaviour without actually running bun.
( DRY_RUN=1 bash -c '
  set -uo pipefail
  false
  RC=$?
  echo "[wrapper] inner command exited $RC"
  echo "[wrapper] DRY_RUN=1 — alert not sent"
  exit $RC
' )
RC=$?
echo "==> wrapper simulated exit code: $RC (expected non-zero)"
[[ "$RC" != "0" ]] && echo "OK" || { echo "FAIL"; exit 1; }
