#!/usr/bin/env bash
# BoJ backfill wrapper — runs the Playwright runner against
# https://www.stat-search.boj.or.jp.
#
# Default host: bb-support (Playwright already installed for V2 E2E).
# If BoJ ever blocks bb-support's IP class, install this wrapper on jarvis
# (residential IP) — same pattern as run-rba-backfill.sh.
#
# Install:
#   sudo cp run-boj-backfill.sh /home/<user>/bin/run-boj-backfill.sh
#   sudo chmod 755 /home/<user>/bin/run-boj-backfill.sh
#
# Usage:
#   /home/<user>/bin/run-boj-backfill.sh <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]
#
# Example (dry-run, recent window):
#   /home/<user>/bin/run-boj-backfill.sh 2026-05-19 2026-05-26 --dry-run
#
# Example (full historical backfill — founder approval required):
#   /home/<user>/bin/run-boj-backfill.sh 1973-01-01 2026-05-26
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
EXTRA="${3:-}"

if [[ -z "$FROM" || -z "$TO" ]]; then
  echo "usage: run-boj-backfill.sh <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]" >&2
  exit 2
fi

REPO_DIR="${ORBI_REPO_DIR:-$HOME/AIHUB/REPOS/orangerails}"
if [[ ! -d "$REPO_DIR/orbi" ]]; then
  echo "ERR: orangerails repo not found at $REPO_DIR" >&2
  exit 1
fi

SOPS_FILE="${ORBI_SOPS_FILE:-/opt/bb-support/.env.sops}"
if [[ ! -f "$SOPS_FILE" ]]; then
  SOPS_FILE="/opt/orangeway/.env.sops"
fi
if [[ ! -f "$SOPS_FILE" ]]; then
  echo "ERR: no .env.sops found (tried /opt/bb-support and /opt/orangeway)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
eval "$(sops --decrypt --output-type dotenv "$SOPS_FILE" \
  | grep -E '^(ORANGERAILS_PROD_ACCESS_TOKEN|ORANGERAILS_PROD_SUPABASE_URL)=')"
set +a

if [[ -z "${ORANGERAILS_PROD_ACCESS_TOKEN:-}" || -z "${ORANGERAILS_PROD_SUPABASE_URL:-}" ]]; then
  echo "ERR: missing ORANGERAILS_PROD_ACCESS_TOKEN / ORANGERAILS_PROD_SUPABASE_URL after decrypt" >&2
  exit 1
fi
export ORANGERAILS_PROD_ACCESS_TOKEN ORANGERAILS_PROD_SUPABASE_URL

cd "$REPO_DIR/orbi"

ARGS=(scripts/central-banks/orchestrator.ts boj "$FROM" "$TO")
if [[ "$EXTRA" == "--dry-run" ]]; then
  ARGS+=(--dry-run)
fi

if command -v bun >/dev/null 2>&1; then
  exec bun run "${ARGS[@]}"
elif command -v tsx >/dev/null 2>&1; then
  exec tsx "${ARGS[@]}"
else
  echo "ERR: neither bun nor tsx is installed on this host" >&2
  exit 1
fi
