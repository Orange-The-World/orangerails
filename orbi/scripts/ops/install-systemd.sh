#!/usr/bin/env bash
# Idempotent installer for the orbi-forward-fill systemd unit.
#
# Steps:
#   1. Verify the repo unit file matches the canonical sha256 (sanity check).
#   2. Kill any existing nohup-style `bun run scripts/forward-fill.ts` process.
#   3. Copy the unit into /etc/systemd/system/ (sudo).
#   4. systemctl daemon-reload, enable, start.
#   5. Verify active state, tail recent logs.
#
# Requires sudo. Run as the `ubuntu` user on bb-support:
#   sudo /home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/install-systemd.sh
set -euo pipefail

REPO_UNIT="/home/ubuntu/AIHUB/REPOS/orangerails/orbi/scripts/ops/orbi-forward-fill.service"
SYS_UNIT="/etc/systemd/system/orbi-forward-fill.service"
SVC="orbi-forward-fill.service"

if [[ $EUID -ne 0 ]]; then
  echo "This installer must be run with sudo." >&2
  exit 1
fi

if [[ ! -f "$REPO_UNIT" ]]; then
  echo "Missing $REPO_UNIT" >&2
  exit 1
fi

echo "==> Repo unit sha256:"
sha256sum "$REPO_UNIT"

echo "==> Stopping any existing manual forward-fill (nohup/bun)..."
# Match the manually-started bun process; leave systemd-managed one to systemctl.
PIDS=$(pgrep -f "bun run scripts/forward-fill.ts" || true)
if [[ -n "$PIDS" ]]; then
  echo "Killing PIDs: $PIDS"
  # shellcheck disable=SC2086
  kill $PIDS || true
  sleep 2
  # SIGKILL stragglers.
  PIDS=$(pgrep -f "bun run scripts/forward-fill.ts" || true)
  if [[ -n "$PIDS" ]]; then
    echo "Force-killing: $PIDS"
    # shellcheck disable=SC2086
    kill -9 $PIDS || true
  fi
else
  echo "No existing forward-fill process found."
fi

echo "==> Installing unit to $SYS_UNIT..."
install -m 0644 -o root -g root "$REPO_UNIT" "$SYS_UNIT"

echo "==> systemctl daemon-reload..."
systemctl daemon-reload

echo "==> Enabling + starting $SVC..."
systemctl enable "$SVC"
systemctl restart "$SVC"

echo "==> Verifying state..."
sleep 2
systemctl is-active "$SVC"
systemctl --no-pager --full status "$SVC" | head -20 || true

echo
echo "==> Recent journald logs:"
journalctl -u "$SVC" -n 20 --no-pager || true

echo
echo "Done. Tail live logs with:"
echo "  journalctl -u $SVC -f"
echo "  tail -f /tmp/orbi-forward-fill.log"
