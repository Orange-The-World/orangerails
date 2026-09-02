-- ============================================================
-- encrypted_transactions: the UPDATE policy it never had
-- ============================================================
-- Requires: 20260421200000_platforms_subaccounts.sql
--
-- WHAT IS MISSING. public.encrypted_transactions has row level security
-- enabled and carries three policies for authenticated users: read
-- (SELECT), insert (INSERT) and delete (DELETE). There is no UPDATE
-- policy, so no authenticated client can rewrite a row it owns. Under
-- PostgREST such an UPDATE matches zero rows and returns 204 with error
-- null, which a caller cannot distinguish from a write that landed.
--
-- WHY IT IS NEEDED. The vault rotation path re-encrypts every transaction
-- row in the browser under the new transactions subkey and rewrites it in
-- place. That is an UPDATE on this table, and it has to land.
--
-- HOW THE GAP AROSE. 20260420200000_workspace_admins.sql created a FOR ALL
-- policy here. 20260421200000_platforms_subaccounts.sql then dropped every
-- policy on the affected tables in a dynamic DO block, which it had to do
-- to drop connections.user_id, and recreated read, insert and delete only.
-- public.connections and public.user_vault_meta both kept an UPDATE policy
-- through that same migration, so the omission looks like an accident of
-- the rebuild rather than an append-only rule anyone intended.
--
-- SCOPE. Same predicate as the existing insert and delete policies, in
-- both USING and WITH CHECK: a user may rewrite the rows under their own
-- connections, and may not move a row onto a connection that is not
-- theirs. This grants no authority a user did not already hold through
-- insert plus delete; it makes the rewrite one statement instead of two.
-- The payload stays ciphertext produced in the browser, so this changes
-- who may write a row and nothing about who can read one.

DROP POLICY IF EXISTS "Direct users can update transactions via their subaccount" ON public.encrypted_transactions;
CREATE POLICY "Direct users can update transactions via their subaccount"
  ON public.encrypted_transactions FOR UPDATE
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  )
  WITH CHECK (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );
