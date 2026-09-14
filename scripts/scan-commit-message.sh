#!/usr/bin/env bash
# scan-commit-message.sh: guard a commit MESSAGE before it is written (OR-T0254).
#
# Companion to pre-publish-scan.sh (guards file CONTENT) and
# .github/workflows/pr-commit-metadata-scan.yml (guards the PR range, after
# the commits already exist). This is the earliest point in the chain: run
# as a git commit-msg hook, it runs before the commit object is created, so
# a restricted value never even reaches a local commit.
#
# Usage: scan-commit-message.sh <path-to-commit-message-file>
# Exit 0: clean. Exit 1: a restricted pattern was found; the caller (the
# commit-msg hook) refuses the commit.
#
# Two pattern sources, kept in lock-step with the PR-range scan so a class
# caught there is caught here too:
#   - GENERIC_PATTERN: structural classes, safe to keep in this committed
#     file because it names a class, not a value (a tailnet hostname, the
#     Tailscale CGNAT block, a knowledge-base document link, a chat
#     permalink, a home directory path). Copied byte-for-byte from
#     GENERIC_PATTERN in pr-commit-metadata-scan.yml; if that one changes,
#     change this one in the same PR.
#   - RESERVED_PATTERN: specific internal terms. Read at runtime from the
#     OR_RESERVED_TERMS environment variable if exported locally, else from
#     a gitignored .reserved-terms file at the repo root (one term per
#     line, blank lines and #-comments ignored) -- the same convention
#     pre-publish-scan.sh already uses for the same reason: committing the
#     list would publish the very strings it exists to keep out.
#
# A contributor who has not populated .reserved-terms locally still gets
# the structural half of the scan. The PR-range CI scan remains the
# backstop for the reserved-term half in that case, and for any commit
# made without this hook installed at all (see CONTRIBUTING.md).

set -uo pipefail

MSG_FILE="${1:-}"
if [ -z "${MSG_FILE}" ] || [ ! -f "${MSG_FILE}" ]; then
  echo "::error::scan-commit-message.sh: no commit message file given (usage: scan-commit-message.sh <path>)"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Identical to GENERIC_PATTERN in .github/workflows/pr-commit-metadata-scan.yml.
GENERIC_PATTERN='tail[a-z0-9]+\.ts\.net|\.tailnet\b|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]+\.[0-9]+|https?://[A-Za-z0-9.-]+/doc/[A-Za-z0-9_-]{6,}|/#narrow/|/home/[a-z][a-z0-9_-]*/'

RESERVED_PATTERN="${OR_RESERVED_TERMS:-}"
if [ -z "${RESERVED_PATTERN}" ] && [ -f "${REPO_ROOT}/.reserved-terms" ]; then
  RESERVED_PATTERN="$(grep -vE '^[[:space:]]*(#|$)' "${REPO_ROOT}/.reserved-terms" | paste -sd'|' -)"
fi

PATTERN="${GENERIC_PATTERN}"
if [ -n "${RESERVED_PATTERN}" ]; then
  PATTERN="${PATTERN}|${RESERVED_PATTERN}"
fi

# Self-test: the pattern must fire on a known structural case and must not
# fire on an ordinary message. This runs every invocation, deliberately: a
# hook that has never been shown to refuse anything is not known to refuse
# anything, and a hook that fires on everything gets disabled within a week.
_ST_POSITIVE="see host.tailscale-canary.ts.net for details"
_ST_NEGATIVE="Read the OHLC result key by shape (see https://docs.example.com/api/reference)"
if ! printf '%s\n' "${_ST_POSITIVE}" | grep -qEi "${GENERIC_PATTERN}"; then
  echo "::error::scan-commit-message.sh self-test FAILED: GENERIC_PATTERN does not match a known tailnet hostname. Refusing to scan with a broken pattern."
  exit 1
fi
if printf '%s\n' "${_ST_NEGATIVE}" | grep -qEi "${GENERIC_PATTERN}"; then
  echo "::error::scan-commit-message.sh self-test FAILED: GENERIC_PATTERN matches an ordinary message. Refusing to scan with a pattern that would block everything."
  exit 1
fi

MATCH_LINE="$(grep -nEi "${PATTERN}" "${MSG_FILE}" | grep -vE '^[0-9]+:#' | head -n1 || true)"
if [ -n "${MATCH_LINE}" ]; then
  CLASS="generic-structural (tailnet host, CGNAT block, knowledge-base link, chat permalink, or home directory path)"
  if [ -n "${RESERVED_PATTERN}" ] && ! printf '%s\n' "${MATCH_LINE}" | grep -qEi "${GENERIC_PATTERN}"; then
    CLASS="reserved-term"
  fi
  echo "::error::commit message refused: it matches a restricted pattern, class=${CLASS}"
  echo "  ${MATCH_LINE}"
  echo ""
  echo "This value must not reach the commit message on this public repository."
  echo "Rephrase the message. Do not bypass this hook (git commit --no-verify) to work around it."
  exit 1
fi

exit 0
