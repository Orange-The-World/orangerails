-- 20260828190000_coadmin_owner_workspace_lookup.sql
--
-- Give a co-admin a way to read the two owner fields the consume path needs,
-- without reading the owner's whole vault metadata row.
--
-- WHAT IS TRUE TODAY. 20260421030000_coadmin_vault_meta_read.sql creates the
-- policy "co-admins can read owner vault meta" FOR SELECT TO authenticated
-- USING (user_id IN (SELECT owner_user_id FROM public.workspace_admins WHERE
-- admin_user_id = auth.uid())). A policy grants a ROW, never a column, so that
-- exposes every column of the owner row to anyone holding a workspace_admins
-- row: the wrapped master key, the recovery blob, the verifier, the wrapped
-- KEM secret, the wrapped signing secret, and now the sealed keyring.
--
-- All of it is sealed under the owner's own master key, so none of it is
-- readable, and no part of the co-admin construction depends on this policy
-- being wide. It is still material the admin has no use for, and the sealed
-- keyring is the one blob that also carries the owner's signing secret. The
-- whole point of handing an admin a projection of the keyring is that the
-- admin never holds the owner's signing secret in any form, because holding it
-- turns "may read my data" into "may sign as me". Handing every admin a sealed
-- copy of exactly that material undercuts the property one layer down.
--
-- WHAT THE CONSUME PATH ACTUALLY READS FROM THE OWNER ROW. Two columns, read
-- at dev head on 2026-08-28 in src/routes/app.tsx:
--   .from("user_vault_meta").select("workspace_key_id, sig_public_key")
-- and nothing else. The admin's own wrapped KEM secret comes from the ADMIN's
-- own row, not the owner's, and it could not come from the owner's: it is
-- unwrapped with the admin's own master key. The recipient public key used at
-- grant time comes from the definer function lookup_user_for_coadmin, not from
-- this policy. The comment at the top of 20260421030000, which says the admin
-- fetches kem_secret_wrapped from the owner row, is wrong and was wrong when it
-- was written.
--
-- WHY A DEFINER FUNCTION AND NOT A NARROWER POLICY. Row level security selects
-- rows, not columns. A column privilege applies to the ROLE, so revoking a
-- column from authenticated would also take it from an owner reading their own
-- row. A definer function returning the two fields is the only construction
-- that narrows the co-admin read without breaking the owner read.
--
-- WHAT THE TWO RETURNED FIELDS ARE, PRECISELY. sig_public_key is a public
-- verification key, published so a grant signature can be checked.
--
-- The workspace key id is NOT public by design and must not be described that
-- way. Every policy on public.wrapped_data_keys resolves who the owner is
-- through user_vault_meta.workspace_key_id, so the value behaves as an
-- authorisation subject and not as an inert identifier. It is disclosed HERE
-- only to a caller that already holds a co-admin grant on that workspace, and
-- that caller already holds the same value as data_key_id on every wrapped key
-- row addressed to them, so this function discloses nothing the caller does
-- not already have. It is not safe to publish more widely, to log, or to
-- expose on a wider endpoint while it is the subject of those owner policies.
-- The uniqueness and write once guards that stop a caller pointing their own
-- row at a workspace key they do not own are in
-- 20260828214500_user_vault_meta_workspace_key_write_once.sql.
--
-- THIS MIGRATION CHANGES NO EXISTING BEHAVIOUR, ON PURPOSE. It is step one of
-- three. Nothing calls this function yet and the wide policy is untouched, so
-- this cannot break the consume path. Step two switches the client to this
-- function. Step three, a separate migration, drops the wide policy once
-- nothing depends on it. Dropping it first would break emergency access, which
-- is the path that gets used exactly when nobody can fix it quickly.
--
-- Idempotent: CREATE OR REPLACE, plus REVOKE and GRANT which can be re-run.

CREATE OR REPLACE FUNCTION public.list_coadmin_workspaces()
RETURNS TABLE(owner_user_id UUID, workspace_key_id UUID, sig_public_key TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN QUERY
  SELECT wa.owner_user_id, uvm.workspace_key_id, uvm.sig_public_key
  FROM public.workspace_admins wa
  JOIN public.user_vault_meta uvm ON uvm.user_id = wa.owner_user_id
  WHERE wa.admin_user_id = auth.uid()
    AND uvm.workspace_key_id IS NOT NULL
    AND uvm.sig_public_key IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.list_coadmin_workspaces() IS
  'The two owner fields a co-admin needs to open a workspace: the workspace key id and the owner public signing key. The signing key is public by design. The workspace key id is not: it is the subject the wrapped_data_keys policies resolve the owner against, and it is disclosed here only to a caller that already holds a co-admin grant on that workspace and already holds the same value on its own wrapped key rows. Do not publish it more widely. Definer, because row level security selects rows and not columns. Returns one row per workspace where the caller holds a co-admin grant and the owner has completed setup.';

REVOKE ALL ON FUNCTION public.list_coadmin_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_coadmin_workspaces() TO authenticated;

-- Prove it, rather than assume the statements above did what they say. The
-- assertion that matters most is the last one: a definer function that leaked a
-- sealed column would be worse than the policy it is meant to replace, because
-- it would bypass row level security as well.
DO $$
DECLARE
  fn_oid oid;
  result_def text;
  sealed_cols text[] := ARRAY[
    'keyring_ciphertext',
    'enc_mek_ciphertext',
    'recovery_ciphertext',
    'vault_verifier_ciphertext',
    'kem_secret_wrapped',
    'sig_secret_wrapped',
    'vault_salt'
  ];
  offenders text;
BEGIN
  SELECT p.oid INTO fn_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'list_coadmin_workspaces'
    AND p.pronargs = 0;
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'public.list_coadmin_workspaces() was not created';
  END IF;

  -- 1. It must be a definer function with a pinned search path, or it either
  --    cannot see past row level security at all or can be steered by the
  --    caller's search path.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn_oid) THEN
    RAISE EXCEPTION 'list_coadmin_workspaces is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = fn_oid
       AND proconfig IS NOT NULL
       AND 'search_path=public' = ANY(proconfig)
  ) THEN
    RAISE EXCEPTION 'list_coadmin_workspaces does not pin search_path';
  END IF;

  -- 2. anon must not be able to call it. The body refuses an unauthenticated
  --    caller as well, but the privilege is the layer that should stop it
  --    first.
  IF has_function_privilege('anon', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute list_coadmin_workspaces';
  END IF;

  -- 3. authenticated must be able to call it, or the replacement path this
  --    migration exists to create is dead on arrival.
  IF NOT has_function_privilege('authenticated', fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute list_coadmin_workspaces';
  END IF;

  -- 4. It must return the two intended fields and nothing sealed. This reads
  --    the declared result type rather than trusting the body above it.
  --    SCOPE, said plainly so nobody reads this for more than it is: it
  --    constrains the SIGNATURE, not the projection. It proves that no sealed
  --    column NAME appears in the declared result type. It does NOT prove the
  --    body selects the columns its result names claim: a body returning
  --    uvm.enc_mek_ciphertext AS sig_public_key would pass it. The body is
  --    what a review has to read, and this check does not replace that.
  SELECT pg_get_function_result(fn_oid) INTO result_def;
  SELECT string_agg(c, ', ' ORDER BY c) INTO offenders
  FROM unnest(sealed_cols) AS c
  WHERE result_def LIKE '%' || c || '%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'list_coadmin_workspaces returns sealed vault material: %', offenders;
  END IF;
END;
$$;
