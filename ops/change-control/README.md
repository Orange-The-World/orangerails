# Change control baseline

`baseline.json` in this directory is the reviewed baseline for the daily change control
drift check. That check reads the repository's live deployment environments and the
migration apply allowlist variables, compares them field by field against this file, and
fails when they differ. A change to any of those settings is therefore visible even though
it leaves behind no commit and no diff of its own.

Two rules follow from that:

1. `baseline.json` records settings that were reviewed. It is not a wish list, and editing
   it to quiet a failing run records the change as normal. Update it only once the new
   value has been reviewed on its own merits.
2. Nothing else belongs in `baseline.json`. JSON carries no comments, and the comparison
   reads the file key by key, so an added key is at best ignored and at worst permanent
   drift. Explanations belong here instead. The comparison never opens this file.

## Why the builder identity is on the production apply allowlist

`MIGRATION_APPLY_ALLOWED_ACTORS_PROD` contains `the-Orange-Juicer`, the shared identity that
authors pull requests in this repository. That was ruled on by the CTO on 2026-09-03 in
OR-T1765, and it stays for now. Two reasons.

**It is currently the only identity that can dispatch a production migration apply.** The
`supabase-prod` environment sets `prevent_self_review: true`, so the other allowlisted
account cannot approve a deployment it dispatched itself. Remove the builder identity and
the next production apply deadlocks waiting for its own approval.

**The allowlist cannot say who dispatched, and never could.** It names a shared identity that
many callers authenticate as, so a run attributed to it identifies the account and not the
caller. The property that actually protects production here is the `supabase-prod`
environment pause: an apply stops for a human approval, and administrators cannot bypass it
(`can_admins_bypass: false`). That protection does not depend on this variable.

So the entry is accepted deliberately, with a known limit, rather than because it reads as
correct. Removing it is tracked separately in OR-T1784 and is to be taken up after the
production apply window on 2026-09-04 closes: removing it before then would remove the only
dispatch path for the migrations queued behind it.
