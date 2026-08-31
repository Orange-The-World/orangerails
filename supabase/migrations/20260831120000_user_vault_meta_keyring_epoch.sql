-- 20260831120000_user_vault_meta_keyring_epoch.sql
--
-- Give the keyring a generation counter, and make the counter an invariant the
-- database enforces rather than something the client is trusted to maintain.
--
-- WHY
-- The keyring blob (user_vault_meta.keyring_ciphertext) is sealed with an AAD that
-- binds user_id and vault_key_version. vault_key_version does not change when a data
-- key is rotated, so the keyring blob from before a rotation and the one from after it
-- are sealed under the same key with the same AAD bytes. Nothing distinguishes them.
-- If the stored ciphertext is replaced with an earlier one it authenticates cleanly,
-- the client keeps using the generation that blob describes, and no error is raised at
-- any layer. keyring_epoch is the value that makes the two blobs distinguishable: the
-- client binds it into the AAD (OR-T0676), and this migration makes the database refuse
-- any write that would let an epoch and a ciphertext drift apart.
--
-- WHAT THIS ADDS
--   1. public.user_vault_meta.keyring_epoch  bigint NOT NULL DEFAULT 1
--      Its own column. It is NOT overloaded onto vault_key_version, which the OR-T0718
--      ruling forbids, and which would not work anyway: the two values change on
--      different events.
--
--   2. public.user_vault_keyring_watermark, one row per user, holding the highest
--      keyring_epoch ever recorded for that user.
--      REQUIREMENT, and this is the part that is easy to undo by accident: this table
--      carries NO foreign key and NO ON DELETE CASCADE to user_vault_meta or to
--      auth.users. A guard that lives only inside the row it protects is removed
--      together with that row, so the watermark has to outlive it. Adding the foreign
--      key later looks like tidying up and removes the invariant.
--      It is written ONLY by the SECURITY DEFINER trigger function below, with
--      search_path pinned in the function definition. The application roles hold no
--      write privilege on it at all. SELECT for the owning user under an RLS policy is
--      expected and is fine: the watermark is an integer about your own vault.
--
--   3. trg_keyring_epoch_guard, BEFORE INSERT OR UPDATE on user_vault_meta, enforcing
--      four conditions:
--        UPDATE, monotonic  NEW.keyring_epoch >= OLD.keyring_epoch
--        UPDATE, coupled    keyring_ciphertext changed implies the epoch strictly rose,
--                           AND the epoch rising implies keyring_ciphertext changed
--        UPDATE, watermark  NEW.keyring_epoch >= the highest epoch ever recorded
--        INSERT, watermark  NEW.keyring_epoch > the highest epoch ever recorded, or any
--                           value >= 1 when this user has no watermark yet
--      The coupled condition is what makes binding the epoch into the AAD sound. An AAD
--      may bind a value only if that value is fixed for the lifetime of the ciphertext
--      it protects. The epoch qualifies only because every epoch change comes with a
--      re-seal, and that is exactly what the coupled condition makes true. Unlike
--      vault_key_version, a trigger CAN enforce it: both columns are in the row in front
--      of it rather than sealed inside the AEAD where a trigger cannot see them.
--
--   4. BEFORE TRUNCATE statement triggers on both tables, plus the matching revoke.
--      TRUNCATE fires no row-level trigger in PostgreSQL, so without this the guard in
--      point 3 would simply not run. The revoke is the control and the trigger is what
--      makes a mistake loud. The table owner can still reset a dev database by disabling
--      the trigger explicitly, which is a visible act rather than a silent one.
--
-- CONSEQUENCE FOR THE CLIENT, tracked on OR-T0676: vault creation can no longer
-- hardcode epoch 1. A user whose vault row was legitimately removed and re-created must
-- start above their watermark. The client rule is nextEpoch = coalesce(watermark, 0) + 1,
-- sealed into the AAD before the insert.
--
-- SCOPE OF THIS CONTROL, stated plainly rather than overclaimed: it constrains what can
-- be written through the application database roles. It does not attempt to constrain a
-- change made with table ownership or superuser rights, and it is not a substitute for
-- protecting those. It narrows the surface, it does not remove it.
--
-- SAFE TO RUN WHEN
-- Zero keyring blobs exist. Counted immediately before applying, 2026-08-31:
--   dev  fzwmnzmtqidumdqjdddz : user_vault_meta 0 rows, keyring_ciphertext non-null 0
--   prod lcdicqalreskibdfxkzb : user_vault_meta 0 rows, and the keyring_ciphertext
--                               column does not exist on that project yet
-- This changes the AAD, which is wire format. It is free while the count is zero. After
-- the first blob exists it becomes a browser-side re-seal of every stored blob with the
-- vault unlocked, which is the operation envelope v3 exists to remove.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS before each CREATE TRIGGER, and grants that are
-- naturally repeatable. A re-run is a no-op rather than an error.
--
-- REVERSIBLE. To undo, in this order:
--   DROP TRIGGER IF EXISTS trg_keyring_epoch_guard ON public.user_vault_meta;
--   DROP TRIGGER IF EXISTS trg_user_vault_meta_no_truncate ON public.user_vault_meta;
--   DROP TRIGGER IF EXISTS trg_keyring_watermark_no_truncate ON public.user_vault_keyring_watermark;
--   DROP FUNCTION IF EXISTS public.enforce_keyring_epoch();
--   DROP FUNCTION IF EXISTS public.forbid_vault_keyring_truncate();
--   DROP TABLE IF EXISTS public.user_vault_keyring_watermark;
--   ALTER TABLE public.user_vault_meta DROP COLUMN IF EXISTS keyring_epoch;
-- Safe while no client is binding the epoch into an AAD, which is true until OR-T0676
-- ships. After that, dropping the column makes stored blobs unopenable and the undo is
-- no longer safe.
--
-- Refs: OR-T0967, OR-T0796, OR-T0718, OR-T0676

BEGIN;

ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS keyring_epoch bigint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.user_vault_meta.keyring_epoch IS
  'Generation counter for keyring_ciphertext, bound into the keyring AAD by the client so a keyring blob sealed under one generation cannot be presented as another. REQUIREMENT: it increases on EVERY re-seal of the keyring, not only on a data key rotation, which includes adding a generation, adding or removing a co-admin entry, and a PQC key change. Monotonic, not required to be contiguous. Enforced by trg_keyring_epoch_guard together with public.user_vault_keyring_watermark. OR-T0967, OR-T0796.';

CREATE TABLE IF NOT EXISTS public.user_vault_keyring_watermark (
  user_id           uuid        PRIMARY KEY,
  max_keyring_epoch bigint      NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_vault_keyring_watermark IS
  'Highest keyring_epoch ever recorded for a user. REQUIREMENT: this value must outlive the user_vault_meta row it protects, so that the epoch of a re-created vault row can still be checked against everything that came before it. DO NOT ADD A FOREIGN KEY and DO NOT ADD ON DELETE CASCADE to user_vault_meta or to auth.users. Linking this table to the row it protects would let the two be removed together and would remove the invariant with them. Written only by the SECURITY DEFINER trigger function public.enforce_keyring_epoch, which is why the application roles hold no write privilege here. OR-T0967, OR-T0796.';

-- Privileges are stated explicitly rather than inherited. A table created in schema
-- public inherits whatever pg_default_acl carries for the creating role, and on these
-- projects that has handed application roles more than intended before (OR-T0701,
-- OR-T0717, OR-T1027). Revoke first, then grant exactly what is needed.
REVOKE ALL ON TABLE public.user_vault_keyring_watermark FROM PUBLIC;
REVOKE ALL ON TABLE public.user_vault_keyring_watermark FROM anon;
REVOKE ALL ON TABLE public.user_vault_keyring_watermark FROM authenticated;
REVOKE ALL ON TABLE public.user_vault_keyring_watermark FROM service_role;
GRANT SELECT ON TABLE public.user_vault_keyring_watermark TO authenticated;

ALTER TABLE public.user_vault_keyring_watermark ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_vault_keyring_watermark_select_own ON public.user_vault_keyring_watermark;
CREATE POLICY user_vault_keyring_watermark_select_own
  ON public.user_vault_keyring_watermark
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.enforce_keyring_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_watermark bigint;
BEGIN
  SELECT w.max_keyring_epoch INTO v_watermark
    FROM public.user_vault_keyring_watermark w
   WHERE w.user_id = NEW.user_id;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.keyring_epoch < OLD.keyring_epoch THEN
      RAISE EXCEPTION 'keyring_epoch must not decrease (old=%, new=%)', OLD.keyring_epoch, NEW.keyring_epoch
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.keyring_ciphertext IS DISTINCT FROM OLD.keyring_ciphertext
       AND NEW.keyring_epoch <= OLD.keyring_epoch THEN
      RAISE EXCEPTION 'keyring_ciphertext changed without raising keyring_epoch (epoch stayed at %)', OLD.keyring_epoch
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.keyring_epoch > OLD.keyring_epoch
       AND NEW.keyring_ciphertext IS NOT DISTINCT FROM OLD.keyring_ciphertext THEN
      RAISE EXCEPTION 'keyring_epoch raised (% to %) without re-sealing keyring_ciphertext', OLD.keyring_epoch, NEW.keyring_epoch
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_watermark IS NOT NULL AND NEW.keyring_epoch < v_watermark THEN
      RAISE EXCEPTION 'keyring_epoch % is below the watermark % already recorded for this user', NEW.keyring_epoch, v_watermark
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF v_watermark IS NOT NULL AND NEW.keyring_epoch <= v_watermark THEN
      RAISE EXCEPTION 'keyring_epoch % must be strictly above the watermark % already recorded for this user', NEW.keyring_epoch, v_watermark
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_watermark IS NULL AND NEW.keyring_epoch < 1 THEN
      RAISE EXCEPTION 'keyring_epoch must be at least 1 on a first insert, got %', NEW.keyring_epoch
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO public.user_vault_keyring_watermark AS w (user_id, max_keyring_epoch, updated_at)
  VALUES (NEW.user_id, NEW.keyring_epoch, now())
  ON CONFLICT (user_id) DO UPDATE
     SET max_keyring_epoch = GREATEST(w.max_keyring_epoch, EXCLUDED.max_keyring_epoch),
         updated_at = now();

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.enforce_keyring_epoch() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.forbid_vault_keyring_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on public.% is refused: TRUNCATE fires no row trigger, so it would erase the keyring epoch state without the guard ever running', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

REVOKE ALL ON FUNCTION public.forbid_vault_keyring_truncate() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_keyring_epoch_guard ON public.user_vault_meta;
CREATE TRIGGER trg_keyring_epoch_guard
  BEFORE INSERT OR UPDATE ON public.user_vault_meta
  FOR EACH ROW EXECUTE FUNCTION public.enforce_keyring_epoch();
ALTER TABLE public.user_vault_meta ENABLE ALWAYS TRIGGER trg_keyring_epoch_guard;

DROP TRIGGER IF EXISTS trg_user_vault_meta_no_truncate ON public.user_vault_meta;
CREATE TRIGGER trg_user_vault_meta_no_truncate
  BEFORE TRUNCATE ON public.user_vault_meta
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_vault_keyring_truncate();
ALTER TABLE public.user_vault_meta ENABLE ALWAYS TRIGGER trg_user_vault_meta_no_truncate;

DROP TRIGGER IF EXISTS trg_keyring_watermark_no_truncate ON public.user_vault_keyring_watermark;
CREATE TRIGGER trg_keyring_watermark_no_truncate
  BEFORE TRUNCATE ON public.user_vault_keyring_watermark
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_vault_keyring_truncate();
ALTER TABLE public.user_vault_keyring_watermark ENABLE ALWAYS TRIGGER trg_keyring_watermark_no_truncate;

REVOKE TRUNCATE ON TABLE public.user_vault_meta FROM PUBLIC, anon, authenticated, service_role;

-- Prove the result inside this transaction or abort. Each property the ruling pins is
-- asserted by name. An assertion that only checked "the trigger exists" would pass just
-- as happily after someone recreated it as BEFORE UPDATE only, which is the exact shape
-- this migration was rewritten to avoid.
DO $assert$
DECLARE
  v_type text; v_nullable text;
  v_def  text;
  v_secdef boolean; v_config text[];
  v_fk int; v_priv text := '';
BEGIN
  SELECT data_type, is_nullable INTO v_type, v_nullable
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user_vault_meta' AND column_name='keyring_epoch';
  IF v_type IS NULL THEN RAISE EXCEPTION 'FAIL: keyring_epoch was not created'; END IF;
  IF v_type <> 'bigint' THEN RAISE EXCEPTION 'FAIL: keyring_epoch must be bigint, got %', v_type; END IF;
  IF v_nullable <> 'NO' THEN RAISE EXCEPTION 'FAIL: keyring_epoch must be NOT NULL'; END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid='public.user_vault_meta'::regclass AND t.tgname='trg_keyring_epoch_guard';
  IF v_def IS NULL OR v_def NOT ILIKE '%BEFORE INSERT OR UPDATE%' THEN
    RAISE EXCEPTION 'FAIL: trg_keyring_epoch_guard must be BEFORE INSERT OR UPDATE, got %', coalesce(v_def,'<missing>');
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid='public.user_vault_meta'::regclass AND t.tgname='trg_user_vault_meta_no_truncate';
  IF v_def IS NULL OR v_def NOT ILIKE '%BEFORE TRUNCATE%' THEN
    RAISE EXCEPTION 'FAIL: trg_user_vault_meta_no_truncate must be BEFORE TRUNCATE, got %', coalesce(v_def,'<missing>');
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='enforce_keyring_epoch';
  IF NOT v_secdef THEN RAISE EXCEPTION 'FAIL: enforce_keyring_epoch must be SECURITY DEFINER'; END IF;
  IF v_config IS NULL OR NOT (array_to_string(v_config,',') ILIKE '%search_path=%') THEN
    RAISE EXCEPTION 'FAIL: enforce_keyring_epoch must pin search_path';
  END IF;

  SELECT count(*) INTO v_fk FROM pg_constraint
   WHERE conrelid='public.user_vault_keyring_watermark'::regclass AND contype='f';
  IF v_fk <> 0 THEN RAISE EXCEPTION 'FAIL: the watermark table must carry NO foreign key, found %', v_fk; END IF;

  SELECT string_agg(r || ':' || p, ' ') INTO v_priv FROM (
    SELECT r, p FROM unnest(ARRAY['anon','authenticated','service_role']) r,
                      unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
     WHERE has_table_privilege(r, 'public.user_vault_keyring_watermark', p)
  ) x;
  IF v_priv IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: application roles hold write privileges on the watermark table: %', v_priv;
  END IF;

  RAISE NOTICE 'OR-T0967 ok: keyring_epoch, watermark table, epoch guard and truncate guards all in place';
END $assert$;

COMMIT;
