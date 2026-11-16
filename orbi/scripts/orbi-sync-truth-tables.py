#!/bin/bash
printf '%s\n' \
  'REFUSING (OR-T2710): /opt/bb-support/scripts/orbi-sync-truth-tables.py is retired.' \
  'This one-time legacy writer targeted orangerails-prod and must not run.' \
  'OR-T2710 step 2 owns the approved migration of these truth tables to orbi-prod.' >&2
exit 78
