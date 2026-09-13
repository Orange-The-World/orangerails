#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  printf "Git hook setup failed: this checkout is not a Git worktree.\n" >&2
  exit 1
fi

existing_hooks_path="$(git config --local --get core.hooksPath || true)"
if [[ -n "$existing_hooks_path" && "$existing_hooks_path" != ".githooks" ]]; then
  printf "Git hook setup refused: local core.hooksPath is already '%s'.\n" "$existing_hooks_path" >&2
  printf "Keep that hook path and chain .githooks/commit-msg from it, or remove the local setting and rerun setup.\n" >&2
  exit 1
fi

if [[ ! -x .githooks/commit-msg ]]; then
  printf "Git hook setup failed: .githooks/commit-msg is not executable.\n" >&2
  exit 1
fi

git config --local core.hooksPath .githooks

if [[ "$(git config --local --get core.hooksPath)" != ".githooks" ]]; then
  printf "Git hook setup failed: core.hooksPath did not persist.\n" >&2
  exit 1
fi

printf "Git hooks active: core.hooksPath=.githooks (commit messages are scanned before commit).\n"
