-- DL-0657 item 3: BEFORE DELETE trigger on KEM vault meta tables.
--
-- Items 1-2 (RESTRICTIVE RLS policy + REVOKE DELETE) block anon and
-- authenticated. service_role bypasses RLS entirely, so a misconfigured
-- server-side call could still delete a row. This trigger closes that gap:
-- a DELETE on either table raises an error for ALL roles unless the calling
-- session has explicitly set app.vault_delete_authorized = 'true'.
--
-- Sanctioned deletion path (Edge Function only):
--   1. BEGIN (implicit in edge function transaction)
--   2. SET LOCAL app.vault_delete_authorized = 'true';
--   3. DELETE FROM user_vault_meta WHERE user_id = $uid;
--      DELETE FROM customer_vault_meta WHERE user_id = $uid;
--   4. Call auth.admin.deleteUser($uid)   -- cascade finds no vault row
--   5. COMMIT
-- Step 2 uses SET LOCAL so the flag is scoped to that transaction only.
-- The trigger fires only on step 3; auth cascade in step 4 finds nothing.

CREATE OR REPLACE FUNCTION public.fn_deny_vault_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
BEGIN
  IF current_setting('app.vault_delete_authorized', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Direct DELETE on % is not permitted. '
    'Use the designated account-deletion Edge Function, which sets '
    'app.vault_delete_authorized = ''true'' before deleting vault rows.',
    TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- user_vault_meta
DROP TRIGGER IF EXISTS deny_delete ON public.user_vault_meta;
CREATE TRIGGER deny_delete
  BEFORE DELETE ON public.user_vault_meta
  FOR EACH ROW EXECUTE FUNCTION public.fn_deny_vault_delete();

-- customer_vault_meta
DROP TRIGGER IF EXISTS deny_delete ON public.customer_vault_meta;
CREATE TRIGGER deny_delete
  BEFORE DELETE ON public.customer_vault_meta
  FOR EACH ROW EXECUTE FUNCTION public.fn_deny_vault_delete();
