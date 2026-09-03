# Change control: the reviewed baseline

`baseline.json` in this directory is the reviewed baseline for the daily
change-control drift check. It records the repository settings that decide who
may apply a database migration in production: the deployment environments and
their reviewer rules, and the two migration apply allowlist variables.

The workflow `.github/workflows/change-control-drift.yml` reads those settings
live once a day and compares them against this file. When they differ it goes
red and names the old value and the new one. It never writes the baseline
itself. A new baseline lands only through a reviewed pull request, so the
recorded values are always ones somebody looked at in a diff.

This file exists because JSON has no comments and the baseline is compared
field by field. A note added inside `baseline.json` would be read as a change
to the settings. So the reasoning lives here, next to the values, in a file the
comparison never opens.

## Why the shared builder identity is on the production allowlist

`MIGRATION_APPLY_ALLOWED_ACTORS_PROD` contains `the-Orange-Juicer`, the shared
identity that authors pull requests in this repository. That is deliberate and
it was ruled on by the CTO on 2026-09-03 in OR-T1765. It stays for now, for two
reasons.

**It is the only identity that can dispatch a production migration apply.** The
`supabase-prod` environment sets `prevent_self_review` to true. A dispatch by
the other allowlisted account therefore deadlocks: that account would have to
approve its own deployment, and the environment refuses. Removing the builder
identity today does not tighten the allowlist, it closes the only working
dispatch path.

**The allowlist cannot say who dispatched, and was never able to.** It names a
shared identity that many callers authenticate as, so the run log records that
identity whichever caller triggered the run. The control that actually holds
production is the `supabase-prod` environment pause: a required reviewer who is
not the dispatcher must approve before anything is written. That pause is
unaffected by this variable.

Removing the builder identity is tracked separately, as OR-T1784, and is not
started until the 2026-09-04 production apply window has closed. Doing it
earlier would leave the pending migrations with no way to be applied at all.
