#!/usr/bin/env bash
# stealth-filter-verify_test.sh
#
# Fixture-based tests for scripts/ops/stealth-filter-verify.sh
#
# All three paths tested here are decision-path checks: they depend only on
# bash, jq, find, sort, date, and curl -- no systemd unit, no production data
# directory, and no live network call is required.
#
#   Property 1: BTC_FILTER_DATA_DIR="" -> non-empty guard (line 105) -> exit 2
#   Property 2: tip manifest backdated 2h -> stale check (line 153) -> exit 1
#   Property 4: curl blocked by 127.0.0.1:1 -> Blockstream guard (line 176) -> exit 2
#
# The happy path (_read_unit_dir returning the real unit dir and a live
# Blockstream response) genuinely requires the production host. That is a
# one-time SRE install smoke after merge, not a merge gate.

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/stealth-filter-verify.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: script not found: $SCRIPT" >&2
  exit 2
fi
chmod +x "$SCRIPT"

command -v jq  &>/dev/null || { echo "ERROR: jq required but not in PATH"  >&2; exit 2; }
command -v curl &>/dev/null || { echo "ERROR: curl required but not in PATH" >&2; exit 2; }

PASS=0
FAIL=0

# run_check <name> <expected-exit> <cmd ...>
# Runs cmd, captures exit code without killing the test runner on failure.
run_check() {
  local name="$1"
  local expected="$2"
  shift 2
  local actual=0
  # The || pattern prevents set -e from aborting when the script under test
  # exits non-zero. actual=$? captures the real exit code.
  "$@" >/dev/null 2>&1 || actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    echo "PASS  $name (exit $actual)"
    PASS=$(( PASS + 1 ))
  else
    echo "FAIL  $name -- expected exit $expected, got $actual"
    FAIL=$(( FAIL + 1 ))
  fi
}

# ---- fixture setup ----------------------------------------------------------

FIXTURE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$FIXTURE_DIR"; }
trap cleanup EXIT

# Two manifest files named by block height (the script sorts them numerically).
# The hash values are placeholder 64-char hex strings; no real Blockstream call
# is made in Properties 1 or 2.
printf '{"block_height":800000,"block_hash":"aaa0000000000000000000000000000000000000000000000000000000000001"}' \
  > "$FIXTURE_DIR/800000.json"
printf '{"block_height":800001,"block_hash":"bbb0000000000000000000000000000000000000000000000000000000000002"}' \
  > "$FIXTURE_DIR/800001.json"

# ---- Property 1: BTC_FILTER_DATA_DIR="" -> exit 2 ---------------------------
#
# With BTC_FILTER_DATA_DIR set to an empty string:
#   - line 91: [[ ! -v BTC_FILTER_DATA_DIR ]] is false (var IS set) -> skip if
#   - line 94: [[ -n "" ]] is false -> skip elif, no systemctl call
#   - line 105: [[ -n "${BTC_FILTER_DATA_DIR:-}" ]] is false -> die 2
#
# No fixture dir, no systemctl, no network needed.

run_check "Property 1: BTC_FILTER_DATA_DIR=\"\" exits 2" 2 \
  env BTC_FILTER_DATA_DIR="" "$SCRIPT"

# ---- Property 2: stale tip manifest -> exit 1 --------------------------------
#
# Fixture dir with two height files; tip (800001.json) is backdated 2 hours.
# Default STALE_THRESHOLD_MINUTES is 60 -> STALE_SECONDS = 3600.
# TIP_AGE_SECONDS ~ 7200 > 3600 -> die 1 at line 153.
#
# _read_unit_dir is called (BTC_FILTER_DATA_DIR is non-empty) but systemctl
# is absent in CI so _UNIT_DIR is empty. The caller-vs-unit check at line 98
# guards [[ -n "$_UNIT_DIR" ]], which is false, so the die 2 there is
# bypassed and execution continues to the stale check.

touch -d "2 hours ago" "$FIXTURE_DIR/800001.json"

run_check "Property 2: tip backdated 2h exits 1" 1 \
  env BTC_FILTER_DATA_DIR="$FIXTURE_DIR" "$SCRIPT"

# Reset tip mtime so Property 4 sees a fresh tip and passes Property 2.
touch "$FIXTURE_DIR/800001.json"

# ---- Property 4: Blockstream unreachable -> exit 2 --------------------------
#
# Fresh tip passes Properties 1 and 2. curl is directed to 127.0.0.1:1 where
# no listener exists; it exits non-zero and BS_RESPONSE is empty.
# line 176: [[ $CURL_RC -eq 0 && -n "$BS_RESPONSE" ]] is false -> die 2.
# BLOCKSTREAM_TIMEOUT=2 keeps the test fast (default is 15s).

run_check "Property 4: Blockstream blocked exits 2" 2 \
  env BTC_FILTER_DATA_DIR="$FIXTURE_DIR" \
      HTTP_PROXY=http://127.0.0.1:1 \
      HTTPS_PROXY=http://127.0.0.1:1 \
      BLOCKSTREAM_TIMEOUT=2 \
      "$SCRIPT"

# ---- results ----------------------------------------------------------------

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
