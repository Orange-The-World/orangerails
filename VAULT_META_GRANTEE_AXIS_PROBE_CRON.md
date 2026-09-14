# Vault meta grantee-axis probe: install

Same shape and same host as `ANON_ACL_INVARIANTS_CRON.md` (OR-T1418). This
is a separate probe with a separate script, unit, timer and state file; it
does not replace that one.

## What it checks

Both Supabase clusters, every hour: that no role outside the allow list
holds any privilege, table or column level, on `public.user_vault_meta` or
`public.customer_vault_meta` (the ACL axis), and that no role outside a
per-cluster expected set is a member of `postgres`, `service_role` or
`or_agent_reader` (the membership axis, which the ACL axis cannot see).
Full design: see `scripts/ops/vault-meta-grantee-axis-probe.sh` header and
ticket OR-T1539.

## Install

1. Place `scripts/ops/vault-meta-grantee-axis-probe.sh` at
   `/usr/local/bin/vault-meta-grantee-axis-probe.sh`, mode 0755.
2. Create `/etc/orbi/vault-meta-grantee-axis-probe.env` (root-only, 0600)
   defining:
   ```
   GRANTEE_AXIS_PROBE_DSN_DEV=postgres://...fzwmnzmtqidumdqjdddz...
   GRANTEE_AXIS_PROBE_DSN_PROD=postgres://...lcdicqalreskibdfxkzb...
   ORBI_ALERT_SCRIPT=/usr/local/bin/orbi-alert.sh
   GRANTEE_AXIS_PROBE_STATE_FILE=/var/lib/orbi/vault-meta-grantee-axis-probe.state
   ```
   Reuses the same `ORBI_ALERT_SCRIPT` transport as every other probe in
   this family. No host path or DSN lives in the repo.
3. Install `orbi-probe-failed@.service` first if it is not already present
   (it is shared across probes; OR-T1418 installs it).
4. Copy `systemd/vault-meta-grantee-axis-probe.service` and `.timer` into
   `/etc/systemd/user/` (or the system unit path this host uses for the
   other probes), then:
   ```
   systemctl daemon-reload
   systemctl enable --now vault-meta-grantee-axis-probe.timer
   ```
5. Confirm a manual run reaches OK before trusting the timer:
   ```
   /usr/local/bin/vault-meta-grantee-axis-probe.sh; echo "exit: $?"
   ```

## Not covered here

Installing the units on the host itself. That is a follow-on once this PR
is merged, same as OR-T1418's own note, and needs a hand with host write.
