# ORBI Anon ACL Invariant Probe

`scripts/ops/orbi-anon-acl-probe.sh` watches the privileges the `anon` role
holds in schema `public` on BOTH Supabase clusters, hourly. Built out of
OR-T1408 / OR-T1418. Design spec: *Anon ACL invariants: scheduled assertion
design and build spec* on wiki.orangerails.dev.

## Why this exists

These are default privileges: they fire again every time an object is
created, so a fix applied once is a state, not an end. The anon-write
problem has already been fixed three times in one week
(OR-T1331/SQLA-00256, the OR-T1394 dev sequence fix, OR-T1407's migration).
A measurement pasted into a ticket note is true for one minute and then it
is history. This is what makes it durable.

## The four assertions

Run against BOTH `fzwmnzmtqidumdqjdddz` (dev) and `lcdicqalreskibdfxkzb`
(prod), independently. All read-only, all sub-second.

| # | Assertion | Red when |
|---|-----------|----------|
| A1 | No relation or function in `public` is owned by anything but `postgres` | any offending owner found; names the object |
| A2 | Default privileges for role `postgres` in `public`, anon entry only | anon default carries anything but exactly `(r, SELECT)`; the required row missing is also red |
| A3 | Set-equality: anon's non-SELECT privileges in `public`, any relkind | anything other than exactly `{(waitlist,INSERT),(adapter_requests,INSERT)}`; extra = escalation, missing = broken signup form |
| A4 | Could-not-check is a distinct outcome | connection failure, query failure, or a required row missing |

A2 asserts the anon entry only, never the whole ACL string: dev and prod
already differ on the non-anon parts of the same default (dev's `r` row
carries `postgres=arwdDxtm`, prod's does not), and that divergence is real,
not a defect, and not held for here.

A3 replaces two assertions from the first draft of the spec that
contradicted each other (a literal "no anon privilege but SELECT" is red on
a correct cluster, because the two signup tables are supposed to hold
INSERT). It is deliberately not filtered by relkind: filtering to `r` and
`p` is exactly how a sequence privilege hole survived three prior sweeps.

## Exit codes

| Exit | Meaning |
|------|---------|
| 0 | OK -- A1 to A4 passed on both clusters |
| 1 | ALARM -- at least one assertion failed on a reachable cluster, and (this run delivered a page OR an identical fingerprint already paged within the dedup window and the state file proving that is readable) |
| 2 | ERROR -- any cluster could not be checked, the alert script is unusable, the state file could not be read or written, or a page could not be delivered |

Exit 1 always means someone was actually told, either this run or within the
dedup window. Every other failure is 2 -- a misconfigured host must never
look like a clean cluster, and an undelivered alarm must never read as a
delivered one.

**Per-cluster independence.** One cluster being unreachable never suppresses
the other cluster's real result. Both always run; the worst result wins (2
beats 1 beats 0). Every alarm line names its cluster and, for A2/A3, the
offending object and privilege -- "A3 failed" with no cluster is not
actionable.

## Hourly cadence and the dedup state file

Daily was rejected: a silently reopened anon write privilege on prod is a
live exposure window, and 24 hours unnoticed is too long for four
sub-second read-only queries. Hourly on a standing red (prod is red on A2
and A3 today, until OR-T1407's migration promotes) creates a paging problem,
so:

* A stable fingerprint of the full failure set (cluster plus every sorted
  offending line) is computed each alarming run.
* A page goes out immediately whenever the fingerprint changes, including
  clean-to-red and one red shape becoming a different one.
* An identical fingerprint already paged within the dedup window
  (`ANON_ACL_DEDUP_SECONDS`, default 24h) is suppressed, but the run still
  exits 1: a page for this exact state was already delivered, and this run
  proved the state file recording that is still readable.

If the state file cannot be read or written, that is exit 2, never a silent
pass, because a dedup mechanism that cannot prove the earlier telling has
not told anybody.

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `ANON_ACL_DSN_DEV` | yes | postgres DSN for `fzwmnzmtqidumdqjdddz` |
| `ANON_ACL_DSN_PROD` | yes | postgres DSN for `lcdicqalreskibdfxkzb` |
| `ORBI_ALERT_SCRIPT` | yes | same alert script the other probes in this family use, called as `<script> <level> <body>`. Checked present and executable before any DB connection opens. |
| `ANON_ACL_STATE_FILE` | yes | absolute path to a small file recording the last fingerprint paged and when. Must persist across runs (not `/tmp`), writable by the unit's user. Checked before any DB connection opens. |
| `ANON_ACL_DEDUP_SECONDS` | no | repeat-page suppression window in seconds, default `86400` |

A single DSN missing does not abort the whole probe: that cluster reports
could-not-check (its own red) while the other cluster's real result still
counts.

## systemd install set

Reuses the existing generic `orbi-probe-failed@.service` handler
(`scripts/ops/orbi-probe-failed.sh`), already installed for the other probes
in this family. Order matters: the handler must exist before this unit is
enabled, or `OnFailure=` resolves to nothing and a probe crash pages nobody.

| # | File in repo | Install to |
|---|--------------|------------|
| 1 | `scripts/ops/orbi-probe-failed.sh` | `/usr/local/bin/orbi-probe-failed.sh` (chmod +x) -- already installed for the other probes |
| 2 | `scripts/ops/orbi-anon-acl-probe.sh` | `/usr/local/bin/orbi-anon-acl-probe.sh` (chmod +x) |
| 3 | `systemd/orbi-anon-acl-probe.service` | `/etc/systemd/system/orbi-anon-acl-probe.service` |
| 4 | `systemd/orbi-anon-acl-probe.timer` | `/etc/systemd/system/orbi-anon-acl-probe.timer` |

Env file `/etc/orbi/orbi-anon-acl-probe.env` carries `ANON_ACL_DSN_DEV`,
`ANON_ACL_DSN_PROD`, `ORBI_ALERT_SCRIPT`, `ANON_ACL_STATE_FILE`. Both DSNs
are fetched from Proton Pass with the documented tooling, never pasted by
hand. The state file path must be on storage that survives a reboot.

Then `systemctl daemon-reload` and:

```
systemctl enable --now orbi-anon-acl-probe.timer
```

**Not in this change:** installing these units on the host. That is a
follow-on once this PR is approved and merged, and it needs a hand with host
write.

## Acceptance: proven red three ways

A check nobody has watched fail is not a check. Three forced failures, all
required, output pasted on OR-T1418:

1. **A2 and A3 red for free, on real prod drift.** Prod is red on both
   today (SRE's baseline in the design spec, re-measured 2026-09-02). Arm
   against prod before OR-T1407's migration (PR #1092) promotes and capture
   the alarm. Self-clears when the migration lands, which also proves the
   probe does not latch.
2. **A1 red by fixture.** We cannot create an object owned by a
   non-`postgres` role on the real clusters (OR-T1388 reproduced the 42501
   refusal), so this is proven in CI against a scratch database where a role
   literally named `postgres` stands in for the real role and a second
   table is deliberately owned by a different role.
3. **A4 red by fixture, twice.** An unreachable DSN gives exit 2. A
   non-executable alert script gives exit 2 with no database call attempted.
   Both proven in CI.

The CI job `orbi-anon-acl-probe-test` in
`.github/workflows/orbi-anon-acl-probe-test.yml` runs on every pull request
that touches this script and proves paths 2 and 3 (and a green baseline, so
the probe is shown NOT to cry wolf on a correct cluster) going the right
color. Path 1 needs a real cluster connection this repo's CI does not have,
so it is captured separately as described above.
