#!/usr/bin/env bash
# RBA backfill wrapper — runs from jarvis (residential IP class), where
# the RBA F11 endpoint is not Akamai-blocked.
#
# Install on jarvis:
#   sudo cp run-rba-backfill.sh /home/kiwi/bin/run-rba-backfill.sh
#   sudo chown kiwi:kiwi /home/kiwi/bin/run-rba-backfill.sh
#   sudo chmod 755 /home/kiwi/bin/run-rba-backfill.sh
#
# Pattern mirrors /home/kiwi/bin/run-v2-playwright.sh — secrets pulled from
# /opt/orangeway/.env.sops at run time, never echoed to stdout.
#
# Usage:
#   /home/kiwi/bin/run-rba-backfill.sh <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]
#
# Example (dry-run):
#   /home/kiwi/bin/run-rba-backfill.sh 2026-05-19 2026-05-26 --dry-run
#
# Example (live PROD write — founder approval required):
#   /home/kiwi/bin/run-rba-backfill.sh 1969-12-09 2026-05-26
#
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
EXTRA="${3:-}"

if [[ -z "$FROM" || -z "$TO" ]]; then
  echo "usage: run-rba-backfill.sh <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]" >&2
  exit 2
fi

REPO_DIR="${ORBI_REPO_DIR:-/home/kiwi/AIHUB/REPOS/orangerails}"
if [[ ! -d "$REPO_DIR/orbi" ]]; then
  echo "ERR: orangerails repo not found at $REPO_DIR" >&2
  echo "     set ORBI_REPO_DIR or clone the repo first." >&2
  exit 1
fi

# Decrypt PROD credentials in-memory only. Never write plaintext to disk.
SOPS_FILE="${ORBI_SOPS_FILE:-/opt/orangeway/.env.sops}"
if [[ ! -f "$SOPS_FILE" ]]; then
  echo "ERR: $SOPS_FILE not present" >&2
  exit 1
fi

# Export only the two vars the orchestrator needs. We pipe sops output into
# a sourced subshell so the decrypted text never lands in argv or files.
set -a
# shellcheck disable=SC1091
eval "$(sops --decrypt --output-type dotenv "$SOPS_FILE" \
  | grep -E '^(ORANGERAILS_PROD_ACCESS_TOKEN|ORANGERAILS_PROD_SUPABASE_URL)=')"
set +a

if [[ -z "${ORANGERAILS_PROD_ACCESS_TOKEN:-}" || -z "${ORANGERAILS_PROD_SUPABASE_URL:-}" ]]; then
  echo "ERR: missing ORANGERAILS_PROD_ACCESS_TOKEN / ORANGERAILS_PROD_SUPABASE_URL after decrypt" >&2
  exit 1
fi

# Make the orchestrator's loadEnv pick up the values. It reads from
# /opt/bb-support/.env on bb-support; on jarvis we just export them and
# patch the orchestrator to fall back to process.env (already supported).
export ORANGERAILS_PROD_ACCESS_TOKEN ORANGERAILS_PROD_SUPABASE_URL

cd "$REPO_DIR/orbi"

ARGS=(scripts/central-banks/orchestrator.ts rba "$FROM" "$TO")
if [[ "$EXTRA" == "--dry-run" ]]; then
  ARGS+=(--dry-run)
fi

# Bun is preferred (matches the bb-support runtime), but fall back to
# node + tsx if Bun isn't installed.
if command -v bun >/dev/null 2>&1; then
  exec bun run "${ARGS[@]}"
elif command -v tsx >/dev/null 2>&1; then
  exec tsx "${ARGS[@]}"
else
  echo "ERR: neither bun nor tsx is installed on this host" >&2
  exit 1
fi
