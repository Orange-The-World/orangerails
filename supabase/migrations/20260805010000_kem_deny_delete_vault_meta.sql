-- DL-0657: Explicit DELETE deny policies on KEM vault meta tables.
--
-- user_vault_meta and customer_vault_meta are write-once by design.
-- Previously the delete-deny relied on the *absence* of a DELETE policy,
-- which is a silent dependency. This migration makes it structural:
-- USING (false) ensures no row ever passes the DELETE check regardless
-- of role or session state.

DROP POLICY IF EXISTS deny_delete_user_vault_meta ON public.user_vault_meta;
CREATE POLICY deny_delete_user_vault_meta
  ON public.user_vault_meta
  FOR DELETE
  USING (false);

DROP POLICY IF EXISTS deny_delete_customer_vault_meta ON public.customer_vault_meta;
CREATE POLICY deny_delete_customer_vault_meta
  ON public.customer_vault_meta
  FOR DELETE
  USING (false);
