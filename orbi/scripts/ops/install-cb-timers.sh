#!/usr/bin/env bash
# Idempotent installer for the ORBI CB daily-refresh + weekly deep-recovery
# systemd units. Run as root on bb-support:
#
#   sudo /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/install-cb-timers.sh
#
# Steps:
#   1. Verify repo files exist + are executable where appropriate.
#   2. Create /var/log/orbi and /var/run/orbi with ubuntu ownership.
#   3. Copy unit files to /etc/systemd/system/.
#   4. daemon-reload, enable + start both timers.
#   5. Print status.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

REPO=/home/ubuntu/AIHUB/REPOS/orangerails
OPS="$REPO/orbi/scripts/ops"

REQUIRED_FILES=(
  "$OPS/cb-daily-refresh.py"
  "$OPS/cb-alert-on-failure.sh"
  "$OPS/cb-refresh-config.json"
  "$OPS/orbi-cb-daily-refresh.service"
  "$OPS/orbi-cb-daily-refresh.timer"
  "$OPS/orbi-cb-deep-recovery.service"
  "$OPS/orbi-cb-deep-recovery.timer"
)
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$f" ]] || { echo "Missing: $f" >&2; exit 1; }
done

echo "==> Ensuring executables..."
chmod +x "$OPS/cb-daily-refresh.py" "$OPS/cb-alert-on-failure.sh"

echo "==> Ensuring /var/log/orbi and /var/run/orbi..."
install -d -o ubuntu -g ubuntu -m 0755 /var/log/orbi
install -d -o ubuntu -g ubuntu -m 0755 /var/run/orbi

echo "==> Installing unit files..."
for unit in \
  orbi-cb-daily-refresh.service \
  orbi-cb-daily-refresh.timer \
  orbi-cb-deep-recovery.service \
  orbi-cb-deep-recovery.timer
do
  install -m 0644 -o root -g root "$OPS/$unit" "/etc/systemd/system/$unit"
  echo "    $unit installed."
done

echo "==> systemctl daemon-reload..."
systemctl daemon-reload

echo "==> Enabling + starting timers..."
systemctl enable --now orbi-cb-daily-refresh.timer
systemctl enable --now orbi-cb-deep-recovery.timer

echo
echo "==> Timer status:"
systemctl list-timers --all 'orbi-cb-*' --no-pager || true

echo
echo "Done. Manual run: sudo systemctl start orbi-cb-daily-refresh.service"
echo "Tail logs:       journalctl -u orbi-cb-daily-refresh -f"
echo "Status JSON:     cat /var/log/orbi/cb-refresh-status.json"
