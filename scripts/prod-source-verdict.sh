#!/usr/bin/env bash
#
# The prod source guard's decision, and the ONLY copy of it.
#
# Called twice by .github/workflows/prod-pr-source-guard.yml: once by the
# self-test step against fixed cases, once by the enforcing step against the
# real pull request. That is the point of the file. Before it existed the two
# steps each carried their own implementation, they could drift apart, and the
# self-test would still report green having proved nothing about the code that
# decided.
#
# Pure string-and-label logic, deliberately. Ancestry is passed IN as an
# argument rather than looked up here, so this runs with no network and no
# token and can be exercised in both directions. The ancestry lookup is an API
# call, it cannot be unit-tested inside a pure function, and so it stays in the
# workflow rather than being pretended otherwise.
#
# Usage:   prod-source-verdict.sh <head_ref> <labels_json> <ancestry>
#   head_ref     the pull request's head branch name
#   labels_json  a JSON array of label names, e.g. '["prod-hotfix"]'
#   ancestry     the compare status of dev...<head sha>, or empty if not looked
#                up or the lookup failed
#
# Prints exactly one of:
#   allow-promotion   head is dev: the promotion itself
#   allow-hotfix      the prod-hotfix label is present
#   allow-release     a release/* head that dev already contains
#   block-ancestry    a release/* head that dev is NOT known to contain
#   block             anything else
#
# FAIL CLOSED. Only the cases written below pass. Everything else, including an
# empty ancestry and an unparseable label list, falls through to block.

set -euo pipefail

head_ref="${1-}"
labels="${2-}"
ancestry="${3-}"

if [ "${head_ref}" = "dev" ]; then
  echo "allow-promotion"
  exit 0
fi

if printf '%s' "${labels}" | jq -e 'any(. == "prod-hotfix")' >/dev/null 2>&1; then
  echo "allow-hotfix"
  exit 0
fi

case "${head_ref}" in
  release/*)
    # behind    = every commit on this head is already on dev
    # identical = this head IS dev's tip
    # Anything else blocks, INCLUDING the empty string, which is what a failed
    # lookup produces.
    if [ "${ancestry}" = "behind" ] || [ "${ancestry}" = "identical" ]; then
      echo "allow-release"
    else
      echo "block-ancestry"
    fi
    exit 0
    ;;
esac

echo "block"
