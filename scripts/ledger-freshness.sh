#!/usr/bin/env bash
# OR-T0957. Decides whether an EMPTY migration ledger means a genuinely fresh
# database or an emptied ledger sitting on top of a populated one. See the
# ticket for the full reasoning behind the three way split; this file is the
# decision itself, sourced by both the real apply-migrations job in
# supabase-deploy.yml and by this script's own self-test in
# .github/workflows/test-ledger-freshness.yml, so what is demonstrated here
# is what actually runs. A second copy of this rule inline in the workflow
# would be a rule that could drift from the one under test.
#
# classify_ledger_freshness <applied_rows> <probe_ok> <object_count>
#   applied_rows  number of rows the ledger query returned (0 or more).
#   probe_ok      1 if a second, independent read of the target's own
#                 catalog (object count in the schemas our migrations write
#                 to) came back as a usable number, 0 if it could not be
#                 read at all (auth failure, timeout, bad shape).
#   object_count  objects found by that probe. Meaningless when probe_ok=0.
#
# Prints exactly one of SKIP / FRESH / POPULATED / UNKNOWN to stdout and
# returns 0 only for SKIP or FRESH (safe to proceed), 1 for POPULATED or
# UNKNOWN (the caller must abort and apply nothing).
#
#   SKIP       applied_rows > 0. The ledger already has entries; there is
#              nothing here to disambiguate, this function has no opinion.
#   FRESH      applied_rows == 0 and the probe read zero objects. The only
#              case where replaying every migration is actually correct,
#              because it is the first apply, not a replay.
#   POPULATED  applied_rows == 0 and the probe read one or more objects: an
#              emptied ledger sitting on a database that already has data.
#              Never proceed here; the recovery is to backfill the ledger,
#              not to run the whole history against live objects again.
#   UNKNOWN    applied_rows == 0 and the probe could not be read. Absence of
#              evidence is not evidence of absence, abort rather than
#              default to the one shape that happens to require no evidence.
classify_ledger_freshness() {
  local applied_rows="$1" probe_ok="$2" object_count="$3"

  if [ "$applied_rows" -gt 0 ]; then
    echo "SKIP"
    return 0
  fi

  if [ "$probe_ok" -ne 1 ]; then
    # Absence of evidence is not evidence of absence. An unreadable probe
    # must never default to the one answer that requires no evidence at all.
    # (This branch shipped as a deliberate bug in the first commit of this
    # PR, to prove the self-test below catches it: see
    # https://github.com/Orange-The-World/orangerails/actions/runs/34009672552
    # for the resulting red run.)
    echo "UNKNOWN"
    return 1
  fi

  if [ "$object_count" -gt 0 ]; then
    echo "POPULATED"
    return 1
  fi

  echo "FRESH"
  return 0
}
