-- DL-0657: Explicit DELETE deny policies on KEM vault meta tables.
--
-- user_vault_meta and customer_vault_meta are write-once by design.
-- Previously the delete-deny relied on the *absence* of a DELETE policy,
-- which is a silent dependency. This migration makes it structural.
--
-- AS RESTRICTIVE: combines with AND, so no future permissive DELETE policy
-- can OR its way past this deny. A plain permissive USING(false) is a no-op
-- because permissive policies combine with OR and deny-by-silence already
-- covers it; only RESTRICTIVE produces an enforceable hard block.
--
-- REVOKE: table-level DELETE grant is the outer control. RLS is client-path
-- only; granting the privilege and relying solely on RLS leaves anon and
-- authenticated able to attempt DELETE at the protocol layer. Revoked here.
--
-- service_role bypasses RLS entirely. Server-side deletion via service_role
-- key remains permitted by this migration. If a hard block is required,
-- add a BEFORE DELETE trigger on each table (Cryptography Engineer to specify).

DROP POLICY IF EXISTS deny_delete_user_vault_meta ON public.user_vault_meta;
CREATE POLICY deny_delete_user_vault_meta
  ON public.user_vault_meta
  AS RESTRICTIVE
  FOR DELETE
  USING (false);

REVOKE DELETE ON public.user_vault_meta FROM anon, authenticated;

DROP POLICY IF EXISTS deny_delete_customer_vault_meta ON public.customer_vault_meta;
CREATE POLICY deny_delete_customer_vault_meta
  ON public.customer_vault_meta
  AS RESTRICTIVE
  FOR DELETE
  USING (false);

REVOKE DELETE ON public.customer_vault_meta FROM anon, authenticated;
