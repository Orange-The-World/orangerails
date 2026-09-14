-- Harden the INSERT policy on public.user_vault_meta so the write-once
-- guarantee on workspace_key_id is enforced the same way on INSERT as it is
-- on UPDATE, instead of relying only on the UNIQUE constraint added for
-- DEV-0364.
--
-- Today the BEFORE UPDATE trigger (write-once guard) only ever fires on the
-- UPDATE path. A raw PostgREST INSERT with a valid JWT could set
-- workspace_key_id to any non-colliding value in the same statement that
-- creates the row, and the trigger would never see it. Neither database
-- this migration targets has a UNIQUE constraint or write-once trigger on
-- workspace_key_id yet; those are added by PR #958 (DEV-0364), open at the
-- time of this migration. Once #958 lands, the UNIQUE constraint alone
-- would still block claiming a value another row already holds, regardless
-- of statement type, but until then and independent of it, this policy is
-- the only guard the INSERT path has. If the constraint is ever dropped or
-- altered, or a future migration adds another insert path, the INSERT side
-- would again be left with no independent guard were this policy also gone.
--
-- This check binds the client role path only: row level security is not
-- FORCEd on this table, so it does not constrain a role that bypasses RLS.
-- This must remain the only INSERT policy on public.user_vault_meta:
-- permissive policies combine with OR, so a second permissive INSERT policy
-- would defeat this conjunct entirely.
--
-- No known write path is affected: the app's only insert into
-- user_vault_meta (src/routes/signup.tsx) never sets workspace_key_id, and
-- the two places that do set it (co-admin.ts, pqc-lifecycle.ts) both use
-- .update(), never .insert().
--
-- Rollback: DROP POLICY IF EXISTS "Users can insert own vault metadata" ON
-- public.user_vault_meta; then recreate it with_check (user_id = auth.uid())
-- only, as it was before this migration.

DROP POLICY IF EXISTS "Users can insert own vault metadata" ON public.user_vault_meta;
CREATE POLICY "Users can insert own vault metadata"
  ON public.user_vault_meta
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND workspace_key_id IS NULL
  );
