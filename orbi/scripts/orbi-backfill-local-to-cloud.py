#!/bin/bash
printf '%s\n' \
  'REFUSING: this script is retired.' \
  'This legacy writer must not run.' \
  'Use the approved orbi-prod sync path instead.' >&2
exit 78
