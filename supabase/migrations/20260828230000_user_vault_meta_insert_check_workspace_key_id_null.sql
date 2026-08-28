-- Harden the INSERT policy on public.user_vault_meta so the write-once
-- guarantee on workspace_key_id is enforced the same way on INSERT as it is
-- on UPDATE, instead of relying only on the UNIQUE constraint added for
-- DEV-0364.
--
-- Today the BEFORE UPDATE trigger (write-once guard) only ever fires on the
-- UPDATE path. A raw PostgREST INSERT with a valid JWT could set
-- workspace_key_id to any non-colliding value in the same statement that
-- creates the row, and the trigger would never see it. This is not
-- exploitable today only because the UNIQUE constraint blocks claiming a
-- value another row already holds, regardless of statement type. If that
-- constraint is ever dropped or altered, or a future migration adds another
-- insert path, the INSERT side would be left with no independent guard.
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
