#!/usr/bin/env bash
# run-v2-playwright.sh  --  inject credentials and run one V2 Playwright spec.
#
# Usage:
#   run-v2-playwright.sh <spec-filename>
#   e.g. run-v2-playwright.sh blink-vault-locked.spec.ts
#
# Credentials are loaded from ~/.v2-test-creds (chmod 600, never committed).
# Create that file with the following vars (all required):
#
#   V2_TEST_BASE_URL=https://v2dev.example.com
#   BLINK_KEY=sk-blink-...
#   VAULT_EMAIL=you@example.com
#   VAULT_PASSWORD=your-v2-login-password
#   VAULT_VAULT_PASSWORD=your-vault-password
#
# Optional (fall back to VAULT_EMAIL / VAULT_VAULT_PASSWORD if absent):
#   V2DEV_EMAIL=you@example.com
#   V2DEV_VAULT_PASSWORD=your-vault-password

set -euo pipefail

SPEC="${1:?Usage: $(basename "$0") <spec-filename>}"
CREDS_FILE="${HOME}/.v2-test-creds"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "${CREDS_FILE}" ]]; then
  echo "ERROR: ${CREDS_FILE} not found." >&2
  echo "Create it (chmod 600) using the template at the top of this script." >&2
  exit 1
fi

if [[ "$(stat -c '%a' "${CREDS_FILE}" 2>/dev/null || stat -f '%OLp' "${CREDS_FILE}")" != "600" ]]; then
  echo "ERROR: ${CREDS_FILE} must be chmod 600. Run: chmod 600 ${CREDS_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${CREDS_FILE}"

# Validate required vars.
for var in V2_TEST_BASE_URL BLINK_KEY VAULT_EMAIL VAULT_PASSWORD VAULT_VAULT_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: ${var} not set in ${CREDS_FILE}" >&2
    exit 1
  fi
done

# Blink / vault-locked spec vars
export BLINK_KEY VAULT_EMAIL VAULT_PASSWORD VAULT_VAULT_PASSWORD

# Playwright baseURL: relative goto('/') resolves against the V2 dev app.
export PLAYWRIGHT_BASE_URL="${V2_TEST_BASE_URL}"
export V2_TEST_BASE_URL

# _v2-session.ts compat aliases so existing specs resolve without re-export.
export V2DEV_EMAIL="${V2DEV_EMAIL:-${VAULT_EMAIL}}"
export V2DEV_VAULT_PASSWORD="${V2DEV_VAULT_PASSWORD:-${VAULT_VAULT_PASSWORD}}"

cd "${REPO_ROOT}"
exec npx playwright test "tests/e2e/${SPEC}" --project=chromium
