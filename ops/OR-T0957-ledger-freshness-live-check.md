# OR-T0957 live verification

This commit exists to trigger a push to dev so the merged ledger-freshness guard
(PR #1393) can be observed aborting for real, on the real apply-migrations job,
instead of inferred from a green PR self-test. Acceptance items 2 and 3 on
OR-T0957 require this.

Procedure: the dev migration ledger (supabase_migrations.schema_migrations) is
snapshotted, then emptied immediately before this branch merges to dev. The
push triggers apply-migrations automatically. Expected result: classify_ledger_freshness
sees zero ledger rows against a populated database and aborts POPULATED, before
the apply loop runs. The ledger is restored from the snapshot immediately after
the run reaches that point, whatever the outcome.

See OR-T0957 in delivery-db for the full record, the run link, and the before
and after row counts.
