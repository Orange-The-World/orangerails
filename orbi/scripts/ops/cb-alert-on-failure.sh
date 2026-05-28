#!/usr/bin/env bash
# Wraps the ORBI CB daily-refresh python script. The script handles its own
# Signal alerting for STALE/EMPTY/ERROR CBs, so this wrapper only fires a
# top-level alert when the script itself crashes (non-zero exit unaccompanied
# by the in-script alert path).
#
# systemd usage:
#   ExecStart=/opt/bb-support/scripts/with-secret.py \
#     --vars ORANGERAILS_PROD_ACCESS_TOKEN,ORANGERAILS_PROD_SUPABASE_URL,BANXICO_API_TOKEN,FRED_API_KEY \
#     -- /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/cb-alert-on-failure.sh "$@"
#
# Args passed through to cb-daily-refresh.py (e.g. --deep-recovery).
set -uo pipefail

REPO=/home/ubuntu/AIHUB/REPOS/orangerails
SCRIPT="$REPO/orbi/scripts/ops/cb-daily-refresh.py"
LOG=/var/log/orbi/cb-refresh.log
FOUNDER_NUMBER="+17057123215"
SENDER_NUMBER="+15128818663"
SIGNAL_URL="http://127.0.0.1:8090/v2/send"

mkdir -p /var/log/orbi || true

# Run the script; tee stdout/stderr to log + journal.
if "$SCRIPT" "$@" 2>&1 | tee -a "$LOG"; then
  RC=0
else
  RC=${PIPESTATUS[0]}
fi

# RC=0 -> all clean. RC=1 -> script already alerted (STALE/ERROR/EMPTY).
# RC>=2 -> script itself crashed before alerting. Fire a fallback alert.
if [[ $RC -ge 2 ]]; then
  TAIL=$(tail -n 20 "$LOG" 2>/dev/null || echo "(no log)")
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  MSG=$(cat <<EOF
ORBI CB daily-refresh CRASHED (exit $RC) at $TIMESTAMP

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

  curl -sS -X POST "$SIGNAL_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /tmp/orbi-cb-alert-last.json 2>>"$LOG" || true
fi

exit "$RC"
