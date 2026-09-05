-- 20260828174500_wrapped_data_keys_owner_select_policy.sql
--
-- DEV-0326. A vault owner cannot delete their own wrapped_data_keys rows, because there
-- is no owner SELECT policy on the table.
--
-- THE PROBLEM. public.wrapped_data_keys gives the owner a DELETE policy and an INSERT
-- policy, and the only SELECT policy is the recipient's. PostgreSQL requires SELECT
-- rights on a row before a DELETE with a WHERE clause can remove it (PostgreSQL 16,
-- CREATE POLICY, DELETE section: "the user must have access to the row(s) being deleted
-- through a SELECT or ALL policy in addition to being granted permission to delete the
-- row(s) via a DELETE or ALL policy"). Every delete we issue against this table carries a
-- WHERE on data_key_id. The authenticated role does hold the SELECT privilege on the
-- table, so this never surfaced as "permission denied": the rows were filtered out and
-- the delete silently removed nothing.
--
-- MEASURED, not inferred. Run on the dev project on 2026-08-28 inside a transaction that
-- was deliberately aborted at the end, so nothing was left behind (auth.users,
-- data_keys, user_vault_meta and wrapped_data_keys were all back to 0 rows and the table
-- was back to 3 policies immediately afterwards). One owner, one recipient, one data key,
-- one wrapped row, acting as role authenticated with request.jwt.claims.sub set to the
-- owner:
--   with the policies as they are today  -> owner SELECT saw 0 rows, owner DELETE removed 0 rows
--   with the policy added below          -> owner SELECT saw 1 row,  owner DELETE removed 1 row
-- So the documented behaviour and the observed behaviour agree, and this policy is what
-- closes the gap.
--
-- WHAT IT BREAKS TODAY. The post-recovery co-admin cleanup (DEV-0317) cannot remove dead
-- key material, and revokeCoAdmin (DEV-0319) appears to succeed while leaving the wrapped
-- key row in place, where the recipient can still read it under the recipient SELECT
-- policy. Not customer-visible: public.wrapped_data_keys and public.workspace_admins both
-- hold zero rows on the production project, so no co-admin grant has ever existed there.
--
-- WHAT THIS EXPOSES, and why it is safe. The policy mirrors the owner check the DELETE
-- policy already uses, so it shows an owner exactly the rows they were already permitted
-- to delete and insert, and nothing else. wrapped_ciphertext is the subkey blob wrapped
-- to the RECIPIENT's ML-KEM public key: the owner minted it and cannot open it, because
-- only the recipient's KEM secret key can, and that key is wrapped under the recipient's
-- own MEK. The owner therefore gains no ability to decrypt anyone's data. What the owner
-- gains is the ability to answer "who currently holds emergency access to my vault" from
-- the key table itself, which today they cannot.
--
-- REVERSIBLE. Adds a SELECT policy and nothing else: no column, constraint, index or row
-- is touched. DROP POLICY "wrapped_data_keys: owner can read their own wrapped keys" ON
-- public.wrapped_data_keys; restores the previous behaviour exactly.
--
-- IDEMPOTENT. Guarded on pg_policy, so a re-run is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.wrapped_data_keys'::regclass
       AND polname  = 'wrapped_data_keys: owner can read their own wrapped keys'
  ) THEN
    CREATE POLICY "wrapped_data_keys: owner can read their own wrapped keys"
      ON public.wrapped_data_keys
      FOR SELECT
      USING (EXISTS (SELECT 1
                       FROM public.user_vault_meta uvm
                      WHERE uvm.user_id = auth.uid()
                        AND uvm.workspace_key_id = wrapped_data_keys.data_key_id));
  END IF;
END;
$$;

-- Prove it landed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.wrapped_data_keys'::regclass
       AND polname  = 'wrapped_data_keys: owner can read their own wrapped keys'
       AND polcmd   = 'r'
  ) THEN
    RAISE EXCEPTION 'owner SELECT policy on public.wrapped_data_keys is missing after this migration';
  END IF;
END;
$$;
