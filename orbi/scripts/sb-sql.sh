#!/usr/bin/env bash
# sb-sql.sh — run a read-only SQL file against a Supabase project via REST/RPC.
# Uses the project's connection string from Supabase management API.
# DO NOT bash -x.
set -euo pipefail

ENVFILE=/opt/bb-support/.env

if [ "$#" -lt 3 ]; then
  echo "usage: sb-sql.sh <token_var> <project_ref> <sql_file>" >&2
  exit 2
fi

TOKEN_VAR="$1"
PROJECT_REF="$2"
SQL_FILE="$3"

# =============================================================================
# ORBI / ORANGERAILS-PROD REFUSAL. Added 2026-09-15 (OR-T2710).
#
# WHY. orangerails-prod has had THREE disk-IO incidents and all three were ORBI:
# 2026-05-30 (a 3.51M-row backfill), 2026-08-06 ("I published ORBI production data to
# the wrong database for 28 hours"), and 2026-09-15. The third was measured from
# pg_stat_statements on lcdicqalreskibdfxkzb: 47,116 calls of ONE ORBI staleness query,
# 240,903 seconds of database time (67 hours) and 4,797,999,848 blocks read, plus 1,872
# refreshes of a matview called orbi_pair_inventory_strength. Roughly one call every three
# minutes for three and a half months. 8,065,813 ORBI rows / 3,264 MB were purged as a result.
#
# IT WAS NOT A CUSTOMER AND NOT A CRON JOB. Every top query ran as role `postgres`, never
# as anon/authenticated/authenticator, and each carried the marker
# "-- source: POST /v1/projects/{ref}/database/query". Those were AGENTS running ad-hoc ORBI
# inventory SQL by hand against the wrong project. Founder, same day: "someone is doing
# something is not supposed to" and "ORBI WAS TAKEN OUT OF ORANGERAILS TO ELIMINATE THESE
# ISSUES MONTHS AGO".
#
# WHY A REFUSAL AND NOT A DOCUMENT. The ruling (2026-07-24, "ORBI stays on its own project")
# was never wrong and never reversed. It was written in a Zulip message and two wiki pages
# and it still failed three times, because prose cannot stop a command. Founder: "I think is
# because agents dont read the repo." So this is the control that does not depend on reading.
#
# HONEST LIMIT, AND IT IS A BIG ONE. This guards the SHARED tool. It cannot stop an agent
# that writes its own curl or urllib request to api.supabase.com, which is how the 47,116
# calls most likely arrived and how orbi-publish.ts wrote for months. It narrows the path,
# it does not close it. The other half of the fix lives in the writers themselves -- see the
# project-ref allowlist compiled into orbi-publish.ts. Do not read this guard as "the
# problem is now impossible".
#
# THE TRAP THAT HID ALL OF THIS: the Management API is addressed by PROJECT REF in the URL,
# NOT by a Postgres DSN. Every audit that hunted the culprit by checking connection strings
# cleared the guilty script. If you are looking for a writer to a Supabase project, grep for
# the ref AND for api.supabase.com/v1/projects.
#
# TO OVERRIDE, if you genuinely must touch an ORBI table on orangerails-prod (for example to
# finish the cleanup itself): SB_SQL_ALLOW_ORBI_ON_RAILS=1 sb-sql.sh ...
# =============================================================================
ORANGERAILS_PROD_REF=lcdicqalreskibdfxkzb
ORBI_PROD_REF=sqcventmypowhbaceufy
# The ORBI table set on orangerails-prod, from the live 2026-09-15 inventory. NOT included
# on purpose: source_wallets, platform_rate_limits, platforms, apps. Those four LOOK like
# ORBI tables and are absent from the local ORBI database entirely -- they belong to the
# Orange Rails API platform and are legitimate traffic here.
ORBI_TABLE_RE='exchange_rates|exchange_rate_resolutions|exchange_rate_providers|orbi_pair_inventory_strength|precious_metals_rates|inflation_rates|monetary_aggregates|historical_money_prices|source_terms_of_service|orbi_'

if [ "$PROJECT_REF" = "$ORANGERAILS_PROD_REF" ] && [ "${SB_SQL_ALLOW_ORBI_ON_RAILS:-0}" != "1" ]; then
  if grep -qiE "$ORBI_TABLE_RE" "$SQL_FILE"; then
    {
      echo "REFUSING: this SQL names an ORBI table and you pointed it at ORANGERAILS-PROD"
      echo "          ($ORANGERAILS_PROD_REF). ORBI's cloud home is orbi-prod ($ORBI_PROD_REF)."
      echo
      echo "          Founder ruling 2026-07-24: ORBI keeps its own project; the lcdicq"
      echo "          migration was CANCELLED, not held. Running ORBI queries here is what"
      echo "          caused three disk-IO incidents -- the last one burned 67 hours of"
      echo "          database time and 4.8 billion block reads on a single staleness query."
      echo
      echo "          The tables were purged on 2026-09-15. Querying them here now returns"
      echo "          nothing useful even when it does not cost anything."
      echo
      echo "          What you almost certainly want:"
      echo "            sb-sql.sh ORBI_PROD_ACCESS_TOKEN $ORBI_PROD_REF $SQL_FILE"
      echo
      echo "          If you really do mean orangerails-prod (finishing the cleanup, say):"
      echo "            SB_SQL_ALLOW_ORBI_ON_RAILS=1 $0 $*"
      echo
      echo "          Background: OR-T2710, and the wiki page \"ORBI must not live on"
      echo "          orangerails-prod\"."
    } >&2
    exit 3
  fi
fi

TOK="$(awk -F= -v key="$TOKEN_VAR" '$1 == key { sub(/^[^=]+=/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$ENVFILE")"

# NOTE ON THIS SCRIPT'S OWN HEADER, which says "run a READ-ONLY SQL file". Nothing here
# enforces that -- the Management API endpoint below happily executes writes and DDL, and
# this script passes the file through unchanged. The comment claims a control the code does
# not implement. Recording it rather than silently changing behaviour, because there are no
# callers today to regress and the next person to add one should know what they are getting.

# Use Management API SQL endpoint
QUERY_JSON="$(jq -Rs '{ query: . }' < "$SQL_FILE")"
curl -sS -X POST \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
  -d "$QUERY_JSON"
