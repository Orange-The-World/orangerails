#!/usr/bin/env bash
# Wraps the ORBI reconciler. On non-zero exit, alerts the founder via the
# signal-cli REST API running on bb-support (127.0.0.1:8090).
#
# Crontab usage (run as `ubuntu`):
#   */5 * * * * sleep 30 && /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/alert-on-failure.sh
#
# Intentionally NOT using `set -e` — we need to capture the exit code, alert,
# and exit with a meaningful status ourselves.
set -uo pipefail

REPO=/home/ubuntu/AIHUB/REPOS/orangerails/orbi
LOG=/tmp/orbi-reconciler.log
ALERT_STATE=/tmp/orbi-alert-last.json
FOUNDER_NUMBER="+17057123215"
SENDER_NUMBER="+15128818663"   # signal-cli registered account on bb-support
SIGNAL_URL="http://127.0.0.1:8090/v2/send"
DRY_RUN="${DRY_RUN:-0}"

cd "$REPO"
if /home/ubuntu/.bun/bin/bun run scripts/reconcile-gaps.ts >> "$LOG" 2>&1; then
  exit 0
fi
RC=$?

TAIL=$(tail -n 20 "$LOG" 2>/dev/null || echo "(no log)")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MSG=$(cat <<EOF
ORBI reconciler FAILED (exit $RC) at $TIMESTAMP

Last lines of $LOG:
$TAIL

Run: ssh ubuntu@100.94.106.84 'tail -50 $LOG'
EOF
)

PAYLOAD=$(jq -nc \
  --arg num "$FOUNDER_NUMBER" \
  --arg sender "$SENDER_NUMBER" \
  --arg msg "$MSG" \
  '{message: $msg, number: $sender, recipients: [$num]}')

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[DRY RUN] would POST to $SIGNAL_URL"
  echo "[DRY RUN] payload:"
  echo "$PAYLOAD" | jq .
  exit "$RC"
fi

curl -sS -X POST "$SIGNAL_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -o "$ALERT_STATE" 2>>"$LOG" || true

exit "$RC"
