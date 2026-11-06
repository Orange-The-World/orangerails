-- DL-1673: write-once guard on public.agent_members identity_pubkey and kem_pubkey.
--
-- Split out of DL-0499, which covered user_vault_meta and customer_vault_meta only.
-- agent_members carries the same class of column: kem_pubkey is what other members
-- wrap data keys against, identity_pubkey is the signing anchor for the row. Before
-- this migration the table had no triggers of any kind on either database, so both
-- columns could be silently changed after activation.
--
-- OR-T0438 surface decision (repository evidence; hosted state was not re-read for
-- this comment): the public agent-members feature was retired, but its database
-- tables were deliberately retained as reversible scaffolding. A later migration,
-- 20260831110000_agent_invitation_authenticate_on_raw_token.sql, records zero
-- agent_members rows on both hosted projects while also recording that the retired
-- edge functions remained deployed and active. Dropping either pubkey column is
-- therefore both founder-gated and inconsistent with the recorded rollback posture.
-- Keep the retained schema safe with this additive, reversible guard instead.
--
-- Why a trigger and not RLS or a column REVOKE: service_role, the SECURITY DEFINER
-- helpers and any future edge function bypass RLS and hold the column grant. A
-- BEFORE UPDATE row trigger fires for every role, so it is the only control that
-- binds all of them.
--
-- First activation is unaffected: NULL to a value is allowed. Only value to a
-- different value, and value to NULL, are refused.
--
-- Rollback (this migration is fully reversible):
--   DROP TRIGGER IF EXISTS trg_agent_members_pubkeys_write_once ON public.agent_members;
--   DROP FUNCTION IF EXISTS public.enforce_agent_member_pubkeys_write_once();
--
-- Shape follows the guards already live on the vault tables: invoker rights
-- (no SECURITY DEFINER), explicit search_path, check_violation errcode.

CREATE OR REPLACE FUNCTION public.enforce_agent_member_pubkeys_write_once()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.identity_pubkey IS NOT NULL
     AND NEW.identity_pubkey IS DISTINCT FROM OLD.identity_pubkey THEN
    RAISE EXCEPTION
      'agent_members.identity_pubkey is write-once and cannot be changed once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.kem_pubkey IS NOT NULL
     AND NEW.kem_pubkey IS DISTINCT FROM OLD.kem_pubkey THEN
    RAISE EXCEPTION
      'agent_members.kem_pubkey is write-once and cannot be changed once set'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_agent_member_pubkeys_write_once() IS
  'BEFORE UPDATE guard on public.agent_members: identity_pubkey and kem_pubkey may be set once (NULL to value) and never changed or cleared afterwards. Fires for every role, including service_role and SECURITY DEFINER callers, which RLS does not bind.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and on this platform that
-- resolves to anon and authenticated as well. Close it explicitly rather than
-- relying on the REVOKE FROM PUBLIC alone, which does not remove per-role grants.
REVOKE ALL ON FUNCTION public.enforce_agent_member_pubkeys_write_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_agent_member_pubkeys_write_once() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_agent_member_pubkeys_write_once() FROM authenticated;

DROP TRIGGER IF EXISTS trg_agent_members_pubkeys_write_once ON public.agent_members;
CREATE TRIGGER trg_agent_members_pubkeys_write_once
  BEFORE UPDATE ON public.agent_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_agent_member_pubkeys_write_once();
