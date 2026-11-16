#!/bin/bash
printf '%s\n' \
  'REFUSING (OR-T2710): /opt/bb-support/scripts/orbi-backfill-local-to-cloud.py is retired.' \
  'This legacy writer targeted orangerails-prod and must not run.' \
  'Use the approved ongoing orbi-prod sync path:' \
  '  /opt/bb-support/scripts/orbi-sync-to-orbi-prod.py' >&2
exit 78
