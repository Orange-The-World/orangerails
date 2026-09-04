-- DL-0418 / DEV-0208: org vault member-add has no working path.
--
-- Adds the three objects the settled design depends on and that were never
-- built: the reconciliation is in Knowledge > Architecture, "Multi-user vault
-- access: what already ships and what is still new (DL-0418)".
--   1. customer_vault_meta.multi_unlock_confirmed_at -- the proven-unlock
--      marker (DL-0484 Rev 5 Blocker 2).
--   2. public.vault_blobs -- the encrypted content table the revoke re-seal
--      transaction and the 10,000 item activation gate both operate on
--      (DL-0484 Rev 5 Blocker 5, DL-0514 Rev 9 Section 6.3).
--   3. public.lookup_vault_pubkey(vault_id, target_user_id) -- the SECURITY
--      DEFINER RPC that lets a vault admin read a prospective member's
--      public key, the first step of wrapping a key for them. Without it the
--      one-row-per-user RLS on user_vault_pubkeys makes member add
--      impossible.
--
-- Two deviations from the DL-0484 draft (written 2026-08-05, before
-- migration 20260815000001 landed), recorded here rather than silently:
--   a. That draft scoped vault_blobs to customer_vault_meta(customer_id).
--      The deployed schema instead threads vault identity through
--      org_vault_meta(vault_id) -- vault_member_slots and
--      org_recovery_challenges both key off it. This migration follows the
--      deployed schema.
--   b. That draft's lookup_vault_pubkey took no vault_id and had no
--      authorization check beyond logging: any authenticated caller could
--      read any user's pubkey. This migration requires an explicit vault_id
--      and that the caller hold an admin slot on it, a strictly narrower
--      and stronger check, and matches the vault-scoped ML-DSA-65 signing
--      the member-add flow already uses (DL-0514 Rev 9 Section 5).
--
-- Canonical revoke block per the CTO mechanism ruling on DL-0418
-- (2026-08-28): one block per object, PUBLIC always named, allow-list GRANT
-- written out, no FORCE ROW LEVEL SECURITY (the SECURITY DEFINER path has
-- to run as the table owner). Extended to the function per Security's
-- same-day addendum: the revoke ships in the same migration as the CREATE,
-- search_path is pinned in the function definition, and the block is
-- verified with has_table_privilege / has_function_privilege, not relacl,
-- because pg_default_acl on this project grants every table privilege to
-- anon and authenticated on any new table by default, and grants EXECUTE to
-- PUBLIC on any new function by default.

-- ALL OR NOTHING. Everything below runs in one transaction so a failure
-- anywhere, including in the ASSERT block at the end, leaves the database
-- exactly as it was and the migration can simply be run again. Without this,
-- a failure after CREATE TABLE would leave vault_blobs behind while the
-- version went unrecorded, and the next run would abort on "relation already
-- exists" with nothing but manual cleanup as the way forward. IF NOT EXISTS
-- was the other option and is weaker: it would accept a half-built table from
-- an earlier failed run whatever shape it had.

BEGIN;

-- 1. Proven-unlock marker ---------------------------------------------------

ALTER TABLE public.customer_vault_meta
  ADD COLUMN IF NOT EXISTS multi_unlock_confirmed_at timestamptz;

COMMENT ON COLUMN public.customer_vault_meta.multi_unlock_confirmed_at IS
  'Set once, atomically, by the SECURITY DEFINER vault-unlock path on the first successful ECIES-path decryption after vault_mode leaves single. The same transaction zeroes enc_mek_ciphertext. Until this is set, enc_mek_ciphertext still holds the pre-share MEK wrap and activation can be rolled back safely. See DL-0484 Rev 5 Blocker 2.';

-- No grant change here: customer_vault_meta already carries RLS policies
-- (Customers read/update/upsert own vault meta, or is_staff()) that are the
-- only control in force, same B7 class as PR #919 but a different table and
-- out of scope for this ticket's acceptance. This is a nullable column on an
-- existing sealed table, not a new sealed surface.

-- 2. vault_blobs -------------------------------------------------------------

CREATE TABLE public.vault_blobs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id   uuid        NOT NULL REFERENCES public.org_vault_meta(vault_id) ON DELETE CASCADE,
  ciphertext bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vault_blobs IS
  'Encrypted content for a shared org vault (org_vault_meta.vault_id). AEAD ciphertext under the vault MEK; server never sees plaintext or the key. All access is through SECURITY DEFINER RPCs not built by this migration (vault-read, vault-write, revoke). The activation gate (max 10,000 rows per vault) and the member-revoke re-seal transaction both operate on this table. See DL-0484 Rev 5 Blocker 5 and DL-0514 Rev 9 Section 6.3.';

CREATE INDEX vault_blobs_vault_id_idx ON public.vault_blobs (vault_id);

ALTER TABLE public.vault_blobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vault_blobs FROM PUBLIC;
REVOKE ALL ON TABLE public.vault_blobs FROM anon;
REVOKE ALL ON TABLE public.vault_blobs FROM authenticated;
-- No GRANT line and no permissive policy: nothing reads or writes this table
-- yet. The three REVOKEs above are what matter, because pg_default_acl on
-- this project grants every table privilege to anon and authenticated on any
-- new table in schema public. After them, PUBLIC, anon and authenticated hold
-- nothing, and with RLS enabled and zero policies there is no client path in.
--
-- WHAT THIS IS NOT: it is not default-deny for every role that is not the
-- table owner. service_role inherits table DML from that same pg_default_acl,
-- this file does not revoke it, and service_role carries BYPASSRLS, so
-- service_role can read and write vault_blobs from the moment it is created.
-- That is the project's settled posture and it is left alone here on purpose,
-- but it is written down rather than implied: whoever builds the vault-read,
-- vault-write and re-seal RPCs on this table needs the real model of who can
-- already touch it. The ASSERT block below proves what anon and authenticated
-- hold and deliberately claims nothing about service_role.

-- 3. lookup_vault_pubkey ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lookup_vault_pubkey(vault_id uuid, target_user_id uuid)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  is_admin  boolean;
  pubkey    bytea;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.vault_member_slots
     WHERE vault_member_slots.vault_id = lookup_vault_pubkey.vault_id
       AND member_user_id = caller_id
       AND role = 'admin'
  ) INTO is_admin;

  IF NOT is_admin THEN
    RAISE EXCEPTION 'not_vault_admin' USING ERRCODE = '42501';
  END IF;

  -- Logged before the data is returned. Reliable for calls made via
  -- PostgREST, where every request auto-commits. A direct SQL caller with a
  -- database connection can wrap this in BEGIN...ROLLBACK and bypass the
  -- log; documented limitation, not claimed exhaustive (DL-0484 Rev 5
  -- Requirement A).
  INSERT INTO public.vault_security_events (user_id, event, metadata)
  VALUES (caller_id, 'pubkey_lookup',
          jsonb_build_object('vault_id', lookup_vault_pubkey.vault_id,
                              'target_user_id', target_user_id, 'ts', now()));

  SELECT x25519_public_key INTO pubkey
    FROM public.user_vault_pubkeys
   WHERE user_id = target_user_id;

  RETURN pubkey; -- NULL if target has not registered a vault pubkey yet
END;
$$;

COMMENT ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) IS
  'SECURITY DEFINER. Lets an admin of vault_id read the registered X25519 public key of target_user_id, the first step of wrapping a vault key for a new member. Fails closed (not_vault_admin) if the caller does not hold an admin slot on vault_id. Every call is logged to vault_security_events. Owner is postgres, matching every other SECURITY DEFINER function in this schema (rotate_data_key, revoke_agent_member); a dedicated least-privilege owner role is a pre-existing gap, not introduced here.';

REVOKE ALL ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_vault_pubkey(uuid, uuid) TO authenticated;
-- authenticated is granted EXECUTE deliberately: the caller is a logged-in
-- admin adding a member from the client, via PostgREST. The function's own
-- admin check, not the grant, is what authorizes the call.

-- 4. The migration proves itself --------------------------------------------

DO $$
BEGIN
  ASSERT has_table_privilege('anon', 'public.vault_blobs', 'SELECT') = false,
    'anon must not hold SELECT on vault_blobs';
  ASSERT has_table_privilege('anon', 'public.vault_blobs', 'INSERT') = false,
    'anon must not hold INSERT on vault_blobs';
  ASSERT has_table_privilege('authenticated', 'public.vault_blobs', 'SELECT') = false,
    'authenticated must not hold SELECT on vault_blobs';
  ASSERT has_table_privilege('authenticated', 'public.vault_blobs', 'INSERT') = false,
    'authenticated must not hold INSERT on vault_blobs';
  ASSERT has_function_privilege('anon', 'public.lookup_vault_pubkey(uuid,uuid)', 'EXECUTE') = false,
    'anon must not hold EXECUTE on lookup_vault_pubkey';
  ASSERT has_function_privilege('authenticated', 'public.lookup_vault_pubkey(uuid,uuid)', 'EXECUTE') = true,
    'authenticated must hold EXECUTE on lookup_vault_pubkey, granted explicitly above';
END $$;

COMMIT;
