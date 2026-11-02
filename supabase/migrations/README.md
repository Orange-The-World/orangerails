# Migrations

Files here are applied in filename order and recorded one row per version in
`supabase_migrations.schema_migrations`.

## Naming

    <version>_<slug>.sql

`<version>` is 14 digits, `YYYYMMDDHHMMSS`, in **UTC**, taken from the real clock
to the second. `<slug>` is lowercase, starts with a letter, and separates words
with underscores.

**Do not type the version by hand.** Generate it:

```
npm run db:new                              # prints just the version
npm run db:new -- add_widget_table          # prints the full path, creates nothing
npm run db:new -- add_widget_table --write  # also writes the file with a header stub
```

The helper reads the clock and also refuses to hand back a version already present
in this directory, walking forward a second at a time. That is what removes the
reason to type a manual "plus one second" after a collision.

## Why this rule exists

Every version in this directory used to be typed by hand and typed rounded. Of 60
distinct versions referenced since 2026-08-20, 45 landed on an exact hour, not one
carried a real seconds value, two were visible manual "plus one second" dodges of
an earlier collision, and one was hour 24, which is not a time that exists. The
format already carries seconds. We were throwing the precision away and then
paying for it.

That produced four duplicate-version collisions in four days.

**A duplicate version is not a cosmetic problem.** `schema_migrations` holds one
row per version, so the second file to arrive is recorded as already applied and
is **silently skipped**. Nothing fails at apply time. It surfaces much later as an
object that does not exist on a cluster whose ledger says it is current. Fixing
one also costs a re-cut pull request and a re-review, because a repo file cannot
be renamed in place by the tooling most authors here have.

## Two constraints, do not break them

1. **Ordering is load bearing.** Out-of-order apply guards depend on the version
   sorting lexically, so it must stay fixed width and left-padded. Do not shorten
   the field and do not add a random suffix before the first underscore.
2. **Everything before the first underscore is the version.** The deploy check
   parses it with `ls | cut -d_ -f1`. The helper reads existing versions with the
   same rule, so the two cannot disagree.

## Writing the file itself

Say in the header what changes, why now, whether it can be undone, and whether it
is idempotent. `--write` gives you that header as a stub.

Guard everything so a re-run is a no-op rather than a second copy or a wedge:
`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE
FUNCTION`, and `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`.

Where a migration asserts its own result, assert the property, not the presence of
something shaped like it. A check that has never been watched to fail is not known
to work.
