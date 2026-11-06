#!/usr/bin/env bash
# bb-support-drift-check.sh
# DL-0784: detect when /opt/bb-support/scripts on bb-us has drifted from origin/prod.
#
# USAGE
#   ./scripts/checks/bb-support-drift-check.sh [/path/to/local/scripts/dir]
#   Default source dir: /opt/bb-support/scripts
#
# EXIT CODES
#   0  all files match origin/prod
#   1  one or more mismatches or read failures (printed to stderr)
#   2  no files found in the source dir (empty scan cannot read as green)
#
# SILENT-SUCCESS GUARD
#   This script always prints "checked N of N" before exiting, so a run that
#   scanned zero files is distinguishable from a run that found no mismatches.
#   A file that cannot be read or compared is a FAILURE (exit 1), not a skip.
#
# INSTALL
#   Host-side timer install is owned by SRE (separate ticket).
#   The script is checked in here so SRE can install exactly what the repo says.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SOURCE_DIR="${1:-/opt/bb-support/scripts}"
REMOTE="origin"
BRANCH="prod"

# Resolve the repo-relative prefix for the scripts dir.
# In the repo the deployed scripts live under scripts/orbi/ or similar;
# we compare by filename against the path origin/prod serves.
# Adjust REPO_PREFIX if the in-repo location differs.
REPO_PREFIX="scripts/orbi"

failures=0
checked=0

# Verify we can talk to the remote before scanning.
if ! git -C "${REPO_ROOT}" fetch --quiet "${REMOTE}" "${BRANCH}" 2>/dev/null; then
  echo "ERROR: could not fetch ${REMOTE}/${BRANCH} - network or auth failure" >&2
  echo "checked 0 of 0 (fetch failed, result is UNKNOWN not clean)" >&2
  exit 1
fi

# Walk every file in the source directory.
while IFS= read -r -d '' live_file; do
  filename="$(basename "${live_file}")"
  repo_path="${REPO_PREFIX}/${filename}"
  checked=$(( checked + 1 ))

  # Get the sha256 of the live file.
  if ! live_sha=$(sha256sum "${live_file}" 2>/dev/null | awk '{print $1}'); then
    echo "MISMATCH (unreadable): ${live_file} -- could not compute sha256" >&2
    failures=$(( failures + 1 ))
    continue
  fi

  # Get the sha256 of the origin/prod version.
  repo_content=$(git -C "${REPO_ROOT}" show "${REMOTE}/${BRANCH}:${repo_path}" 2>/dev/null) || {
    echo "MISMATCH (missing in repo): ${live_file} has no counterpart at ${repo_path} on ${REMOTE}/${BRANCH}" >&2
    failures=$(( failures + 1 ))
    continue
  }

  repo_sha=$(printf '%s' "${repo_content}" | sha256sum | awk '{print $1}')

  if [ "${live_sha}" != "${repo_sha}" ]; then
    echo "MISMATCH: ${live_file}" >&2
    echo "  live sha256 : ${live_sha}" >&2
    echo "  repo sha256 : ${repo_sha} (${REMOTE}/${BRANCH}:${repo_path})" >&2
    failures=$(( failures + 1 ))
  fi
done < <(find "${SOURCE_DIR}" -maxdepth 1 -type f -print0 2>/dev/null)

# A scan of zero files is not clean -- it means the source dir is empty or missing.
if [ "${checked}" -eq 0 ]; then
  echo "ERROR: no files found in ${SOURCE_DIR} -- is the path correct?" >&2
  echo "checked 0 of 0 (no files scanned, result is UNKNOWN not clean)" >&2
  exit 2
fi

echo "checked ${checked} of ${checked}"

if [ "${failures}" -gt 0 ]; then
  echo "FAIL: ${failures} of ${checked} file(s) mismatched or unreadable" >&2
  exit 1
fi

echo "OK: all ${checked} file(s) match ${REMOTE}/${BRANCH}"
exit 0
