# Migration bundle: authz hardening (DL-1562)

Ordered application plan for three migrations absent from the prod Supabase
schema_migrations ledger. The DBA applies these to prod in sequence after the
Auditor pass on this PR.

## Application order

1. `20260727000000_data_keys_ownership_and_rotate_authz.sql`
   Creates the data_keys table, RLS owner-select policy, corroborated backfill
   from user_vault_meta, and the FK constraint on wrapped_data_keys.

2. `20260723190000_revoke_anon_execute_public_functions.sql`
   Revokes anon EXECUTE on 27 public functions (10 Group A, 17 Group B).
   Idempotent; uses to_regprocedure so absent signatures are skipped safely.

3. `20260806200000_rotate_data_key_current_membership_and_grant_sig.sql`
   Final rotate_data_key: current-membership authz (owner or workspace_admins
   only) + fail-closed grant_sig pre-flight + grant_sig/grant_sig_alg writes.
   Clears Auditor hold from PR #626. Supersedes 20260805100000.

## Why this order

Step 3 depends on the data_keys table (step 1). Applying 20260727000000 out of
date order (after 20260805100000, which is already PRESENT on prod) would have
clobbered the grant_sig-aware function and broken rotation. The authz rewrite
(step 3) is the canonical resolution.

Step 2 is idempotent and can run at any point, but runs after step 1 so it
catches the final rotate_data_key function signature installed by step 3.

## Review requirements

- Auditor pass required: yes (step 3 touches the encryption surface).
- 20260806200000 does NOT receive a ledger stamp; it lands as a reviewed forward
  migration per CTO ruling DL-1562.

## Post-application verification

After each step the DBA confirms via read-only query:
- Step 1: SELECT count(*) FROM public.data_keys; and FK constraint present.
- Step 2: has_function_privilege check returns false for anon on all 27 sigs.
- Step 3: rotate_data_key function body shows current-membership authz + grant_sig.
