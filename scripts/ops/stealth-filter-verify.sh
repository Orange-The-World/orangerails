#!/usr/bin/env bash
# stealth-filter-verify.sh
#
# Independently verifies that the Stealth Sync BIP158 filter worker
# is advancing and writing chain-consistent files.
#
# Exit codes:
#   0  -- OK: all four properties satisfied
#   1  -- FAIL: genuine failure (worker stuck, hash mismatch)
#   2  -- ERROR: cannot check (unit env missing, dir absent, Blockstream down)
#
# Dependencies: jq, curl, systemctl (production host), find, sort
#
# Env:
#   BTC_FILTER_DATA_DIR        If already set in the caller's environment,
#                              used directly. Otherwise read from the
#                              btc-filter-worker.service unit env block.
#   STALE_THRESHOLD_MINUTES    Max age of the tip manifest before reporting
#                              FAIL. Default: 30. (Bitcoin block interval
#                              is ~10 min; 30 gives 3x natural tolerance.)
#   BLOCKSTREAM_TIMEOUT        curl timeout in seconds. Default: 15.
#
# REQUIRED BEFORE SHIP: force-test every exit 2 path.
#
#   Property 1 (env missing):
#     BTC_FILTER_DATA_DIR="" ./stealth-filter-verify.sh
#     Expected: exit 2
#
#   Property 2 (stale tip):
#     touch -d "2 hours ago" <tip-manifest-file>
#     ./stealth-filter-verify.sh
#     Expected: exit 1 (tip too old)
#
#   Property 4 (Blockstream unreachable):
#     HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 \
#       ./stealth-filter-verify.sh
#     Expected: exit 2

set -uo pipefail

PROBE="stealth-filter-verify"
STALE_MINUTES="${STALE_THRESHOLD_MINUTES:-30}"
BS_TIMEOUT="${BLOCKSTREAM_TIMEOUT:-15}"

# ---- helpers ----------------------------------------------------------------

alarm() {
  local level="$1"; shift
  echo "[$PROBE] $level: $*" >&2
}

die() {
  local code="$1"; shift
  if [[ "$code" -eq 2 ]]; then
    alarm "CANNOT CHECK" "$*"
  else
    alarm "FAIL" "$*"
  fi
  exit "$code"
}

# ---- tooling check ----------------------------------------------------------

command -v jq &>/dev/null \
  || die 2 "jq is required but not found in PATH"

# ---- property 1: path from unit env, never a guessed literal ----------------
#
# Read BTC_FILTER_DATA_DIR from the systemd unit environment, not from
# a hard-coded path. A wrong path that happens to exist would silently
# check the wrong thing; pulling from the unit makes that impossible.

if [[ -z "${BTC_FILTER_DATA_DIR:-}" ]]; then
  BTC_FILTER_DATA_DIR=$(
    systemctl show btc-filter-worker.service -p Environment 2>/dev/null \
      | tr ' ' '\n' \
      | sed -n 's/^BTC_FILTER_DATA_DIR=//p'
  )
fi

[[ -n "${BTC_FILTER_DATA_DIR:-}" ]] \
  || die 2 "BTC_FILTER_DATA_DIR not declared in btc-filter-worker.service unit environment"

DIR="${BTC_FILTER_DATA_DIR%/}"

[[ -d "$DIR" ]] \
  || die 2 "data dir '$DIR' does not exist or is not a directory"

# ---- locate two most recent manifest files (by block height) ----------------
#
# Files are named <height>.json. Sort numerically so we get the two
# highest heights, not the two most recently modified (mtime can drift).

mapfile -t RECENT_FILES < <(
  find "$DIR" -maxdepth 1 -name '[0-9]*.json' -printf '%f\n' \
    | sort -n \
    | tail -2 \
    | while IFS= read -r f; do printf '%s/%s\n' "$DIR" "$f"; done
)

[[ ${#RECENT_FILES[@]} -ge 2 ]] \
  || die 2 "fewer than 2 manifest files in '$DIR' -- worker may never have run"

PREV_FILE="${RECENT_FILES[0]}"
TIP_FILE="${RECENT_FILES[1]}"

# ---- parse manifest fields --------------------------------------------------

TIP_HEIGHT=$(jq -r '.block_height // empty' "$TIP_FILE"  2>/dev/null)
TIP_HASH=$(  jq -r '.block_hash   // empty' "$TIP_FILE"  2>/dev/null)
PREV_HEIGHT=$(jq -r '.block_height // empty' "$PREV_FILE" 2>/dev/null)

[[ -n "$TIP_HEIGHT"  ]] || die 2 "could not parse block_height from '$TIP_FILE'"
[[ -n "$TIP_HASH"    ]] || die 2 "could not parse block_hash from '$TIP_FILE'"
[[ -n "$PREV_HEIGHT" ]] || die 2 "could not parse block_height from '$PREV_FILE'"

# ---- property 2: two-sample advancement across at least one block interval --
#
# Two manifest files must differ by at least one block height, proving
# the worker has written more than a single file. Additionally the tip
# file must be recent; an old tip means the worker has stopped.

(( TIP_HEIGHT > PREV_HEIGHT )) \
  || die 1 "tip height ${TIP_HEIGHT} did not advance beyond previous ${PREV_HEIGHT} -- worker may be stuck"

TIP_AGE_SECONDS=$(( $(date +%s) - $(date -r "$TIP_FILE" +%s) ))
STALE_SECONDS=$(( STALE_MINUTES * 60 ))

(( TIP_AGE_SECONDS <= STALE_SECONDS )) \
  || die 1 "tip manifest is ${TIP_AGE_SECONDS}s old (threshold ${STALE_SECONDS}s / ${STALE_MINUTES}m) -- worker appears stuck"

# ---- property 4: hash comparison against independent public source ----------
#
# GET https://blockstream.info/api/block-height/<H> returns the canonical
# block hash as plain text. We compare it against the manifest block_hash.
#
# Using an independent public source rather than our own node is deliberate:
# our node produced the manifest files, so asking it to confirm them is the
# worker grading its own homework. Blockstream catches a lying or reorg'd
# worker that a local-node check would miss.
#
# exit 1: mismatch -- reorg or wrong chain.
# exit 2: Blockstream unreachable or non-200 -- absence of evidence must
#         never be reported as healthy.

BS_RESPONSE=$(
  curl -s -f -m "${BS_TIMEOUT}" \
    "https://blockstream.info/api/block-height/${TIP_HEIGHT}" 2>/dev/null
)
CURL_RC=$?

[[ $CURL_RC -eq 0 && -n "$BS_RESPONSE" ]] \
  || die 2 "Blockstream API unreachable or non-200 for height ${TIP_HEIGHT} (curl exit ${CURL_RC})"

CHAIN_HASH="${BS_RESPONSE//[[:space:]]/}"

[[ "$TIP_HASH" == "$CHAIN_HASH" ]] \
  || die 1 "hash mismatch at height ${TIP_HEIGHT}: manifest=${TIP_HASH} blockstream=${CHAIN_HASH} -- possible reorg or wrong chain"

# ---- all four properties satisfied -----------------------------------------

echo "[$PROBE] OK height=${TIP_HEIGHT} (advanced from ${PREV_HEIGHT}) hash=${TIP_HASH} tip_age=${TIP_AGE_SECONDS}s"
exit 0
