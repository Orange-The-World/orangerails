# Anon ACL Invariants Probe

Script in `scripts/ops/` that guards the `anon` role's privileges in
schema `public` on BOTH Supabase clusters (dev `fzwmnzmtqidumdqjdddz`,
prod `lcdicqalreskibdfxkzb`). Design spec: OR-T1408.

## scripts/ops/anon-acl-invariants-probe.sh

Runs four assertions against each cluster and reports the worst outcome:

| # | Assertion |
|---|-----------|
| A1 | zero relations and zero functions in schema public owned by anything other than `postgres` |
| A2 | default ACLs for role `postgres` in public, anon entry only: objtype `r` is exactly SELECT, objtypes `S` and `f` name no anon entry |
| A3 | the set of `(relkind, relation, privilege)` where anon holds a non-SELECT privilege in public, any relkind, equals exactly `(r, adapter_requests, INSERT)` and `(r, waitlist, INSERT)` |
| A4 | could-not-check is its own outcome, never a pass |

### Exit codes

| Exit | Meaning | When to alert |
|------|---------|---------------|
| 0 | OK -- every assertion passed on every cluster | no action |
| 1 | ALARM -- a page was delivered this run, or an identical failure fingerprint was already paged within `ANON_ACL_DEDUP_HOURS` and the state file recording that delivery was readable | page on-call |
| 2 | ERROR -- could not reach a cluster, a query failed, the alert script is unusable, the page could not be delivered, or the dedup state file could not be read or written when a paging decision depended on it | page on-call (higher priority) |

One cluster being unreachable never suppresses the other cluster's
result: both are always attempted, and the worst outcome wins (any
ERROR beats any ALARM beats OK). Every alarm body names the cluster and
the offending object and privilege.

### Cadence and dedup

Runs **hourly**. A silently reopened anon write privilege on prod is a
live exposure window; 24 hours unnoticed is too long for four
sub-second read-only queries.

Hourly on a standing red needs dedup, so the probe fingerprints the
failure set (cluster plus the sorted offending rows) and pages
immediately whenever that fingerprint changes, including a clean run
turning red. A repeat of the exact same fingerprint is suppressed for
`ANON_ACL_DEDUP_HOURS` (default 24) once a page for it has been
delivered and recorded. The dedup record lives in
`ANON_ACL_PROBE_STATE_FILE`, a plain two line file: fingerprint, then a
UTC unix timestamp.

### Environment

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ANON_ACL_PROBE_DSN_DEV` | yes | -- | read-only postgres DSN for the dev cluster |
| `ANON_ACL_PROBE_DSN_PROD` | yes | -- | read-only postgres DSN for the prod cluster |
| `ORBI_ALERT_SCRIPT` | yes | -- | absolute path to the host's existing alert script, called as `<script> <level> <body>`. Same transport as every other probe in this family: one alert path per host. Supplied by the systemd unit environment so no host path lives in this repo. The probe exits 2 before touching either cluster if it is unset, missing, or not executable. |
| `ANON_ACL_PROBE_STATE_FILE` | yes (for the dedup decision) | -- | absolute path to a small read/write file used only to fingerprint and dedup a standing ALARM. Not required on a clean run beyond a best-effort write. |
| `ANON_ACL_DEDUP_HOURS` | no | 24 | hours to suppress a repeat identical page |

A cluster missing its own DSN is reported as that cluster's ERROR
result rather than aborting the whole run, so the other cluster's
result is never lost.

### systemd install set

Reuses the existing generic `orbi-probe-failed@.service` handler
already installed for the other probes in this family. Install order
matters: the handler must exist before this unit is enabled, or
`OnFailure=` resolves to nothing and a probe crash pages nobody.

| # | File in repo | Install to |
|---|--------------|------------|
| 1 | (existing) `scripts/ops/orbi-probe-failed.sh` | `/usr/local/bin/orbi-probe-failed.sh` (chmod +x) |
| 2 | (existing) `systemd/orbi-probe-failed@.service` | `/etc/systemd/system/orbi-probe-failed@.service` |
| 3 | `scripts/ops/anon-acl-invariants-probe.sh` | `/usr/local/bin/anon-acl-invariants-probe.sh` (chmod +x) |
| 4 | `systemd/anon-acl-invariants-probe.service` | `/etc/systemd/system/anon-acl-invariants-probe.service` |
| 5 | `systemd/anon-acl-invariants-probe.timer` | `/etc/systemd/system/anon-acl-invariants-probe.timer` |

The probe env lives at `/etc/orbi/anon-acl-invariants-probe.env` and is
read by both the probe unit and the handler, so the alarm webhook is
configured once. It carries `ANON_ACL_PROBE_DSN_DEV`,
`ANON_ACL_PROBE_DSN_PROD`, `ORBI_ALERT_SCRIPT` and
`ANON_ACL_PROBE_STATE_FILE`. Credentials are fetched from Proton Pass
with the documented tooling, never pasted into this file by hand.

Then `systemctl daemon-reload` and
`systemctl enable --now anon-acl-invariants-probe.timer`.

### Acceptance: every exit path must be watched going red

An assertion nobody has watched fail is not an assertion. This
installing follow-on (host write, not part of OR-T1418) still owes:

1. **Alarm path.** Confirm a real ALARM (dev or prod drift) actually
   arrives in the destination topic, not just that the unit journal
   shows red.
2. **OnFailure path.** Rename the probe script, start the unit, and
   confirm a message arrives naming the failed unit. Restore the
   script afterwards.

OR-T1418 itself carries the three required proofs that the assertions
can go red: real prod drift on A2/A3, a forced A1 fixture, and two
forced A4 cases (unreachable DSN, non-executable alert script). See
that ticket for the captured output.

## Do not conflate this with the OR-T1377 truth-table checks

Both land in the same `scripts/ops/` family and reuse the same
handler, but they assert opposite expected owners on different
databases:

* This probe's A1 is about schema `public` on the two Orange Rails
  Supabase clusters, where the correct owner is `postgres`.
* `orbi-ownership-drift-probe.sh` (OR-T1377) is about the
  `orange_world` truth tables, a different surface, where the expected
  owner is `orbi_writer`.

Keep the DSN and the expected owner bound together in one place per
check. Pointing either check at the other's surface makes it red
forever for a reason that has nothing to do with a real drift.
