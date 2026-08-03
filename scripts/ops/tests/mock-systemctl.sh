#!/usr/bin/env bash
# mock-systemctl.sh
#
# CI stand-in for `systemctl is-active <service>`.
# Prints the value of MOCK_STATE (default: "inactive") so the
# liveness script can be driven through any exit-code path without
# requiring a real systemd on the runner.
#
# Usage (called by orbi-forward-fill-liveness.sh via SYSTEMCTL_BIN):
#   SYSTEMCTL_BIN=scripts/ops/tests/mock-systemctl.sh \
#   MOCK_STATE=active \
#     ./scripts/ops/orbi-forward-fill-liveness.sh

# Accept and ignore any arguments (is-active <service-name>)
echo "${MOCK_STATE:-inactive}"
