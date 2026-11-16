#!/bin/bash
printf '%s\n' \
  'REFUSING (OR-T2710): /opt/bb-support/scripts/orbi_query.sh is retired.' \
  'Use the approved orbi-prod tool:' \
  '  /opt/bb-support/scripts/sb-sql.sh ORBI_PROD_ACCESS_TOKEN sqcventmypowhbaceufy <sql_file>' >&2
exit 78
