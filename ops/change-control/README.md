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
2. Nothing else belongs in `baseline.json`. JSON carries no comments, and the comparison is a
   key by key diff across both files with only `read_at` excluded, so any key added to
   `baseline.json` is reported as a difference and the check goes red every day until it is
   removed. Explanations belong here instead. The comparison never opens this file.

## Why the builder identity is on the production apply allowlist

`MIGRATION_APPLY_ALLOWED_ACTORS_PROD` contains `the-Orange-Juicer`, the shared identity that
authors pull requests in this repository. That was ruled on by the CTO on 2026-09-03 in
OR-T1765, and it stays for now. Two reasons.

**Which identity dispatches decides who is left to approve.** The allowlist records two
accounts, `MorningRevolution` and `the-Orange-Juicer`. The `supabase-prod` environment
requires a reviewer, sets `prevent_self_review: true`, and lists `Making-the-World-Orange`
and `MorningRevolution` as its reviewers. A run dispatched by `MorningRevolution` therefore
cannot be approved by `MorningRevolution`, which leaves one reviewer whose use in this
repository is filing code reviews rather than releasing deployments. A run dispatched by
`the-Orange-Juicer`, which is on the apply allowlist and not on the reviewer list, leaves
both reviewers available. Removing the builder identity removes the dispatch path that has
an approver, not merely a name from a list.

**The allowlist cannot say who dispatched, and never could.** It names a shared identity that
many callers authenticate as, so a run attributed to it identifies the account and not the
caller. The property that actually protects production in this
repository is the `supabase-prod` environment pause: an apply stops for an approval by one of
that environment's reviewers, and administrators cannot bypass it
(`can_admins_bypass: false`). That pause does not depend on this variable, which is what
makes this one entry in this one allowlist tolerable. It is not a general licence. It holds
only while `prevent_self_review` is `true` and `can_admins_bypass` is `false` on
`supabase-prod`, and it is void the moment either changes. Both of those fields are recorded
in `baseline.json` and watched by the same drift check, so the condition this exception rests
on is itself monitored.

So the entry is accepted deliberately, with a known limit, rather than because it reads as
correct. Removing it is tracked separately in OR-T1784 and is to be taken up after the
production apply window on 2026-09-04 closes: removing it before then would leave the queued
migrations with no dispatch path that has an available approver.

## The recorded value, and where the decision lives

The value this section is about, as recorded in `baseline.json` when this was written:

```json
"MIGRATION_APPLY_ALLOWED_ACTORS_PROD": [
  "MorningRevolution",
  "the-Orange-Juicer"
]
```

Keeping `the-Orange-Juicer` in that list is a decision, not an oversight. It was made by the
CTO on 2026-09-03, and the reasoning, the conditions above and the review trigger are
recorded on OR-T1765 in the note dated 2026-09-03 03:05 UTC. This file states the decision.
It is not the decision, and it cannot be used to change one.

A pull request that changes `MIGRATION_APPLY_ALLOWED_ACTORS_PROD` in `baseline.json` must
update the block quoted above in the same pull request, so a reviewed value and the reason
recorded for it cannot part company.

That is no longer only a rule someone has to remember. `scripts/change-control-annotation.mjs`
reads the value out of `baseline.json` and the value out of the block quoted above, and the
drift workflow fails and names both when they differ. Order inside the list is not compared,
because order carries no meaning in an allowlist; an added, removed or changed identity does.
A quoted block that is missing, duplicated or unparseable is its own distinct failure rather
than a pass, for the same reason the drift check answers an unreadable API with an error
instead of silence. Both files are in the workflow's pull request path list, so the check runs
on the pull request that would break it.
