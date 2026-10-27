-- 20261027120000_keyring_epoch_guard_verifier_clause.sql
-- Requires: 20260831120000
--
-- A vault that holds a keyring must not have its vault key replaced unless the keyring is
-- re-sealed under the new key in the same statement.
--
-- WHY
-- Envelope v3 keeps the data keys and the post-quantum secrets in a keyring
-- (user_vault_meta.keyring_ciphertext) sealed under the vault key. A write that replaces
-- the vault key rewrites vault_verifier_ciphertext (the verifier is derived from the vault
-- key and is rewritten only when the key changes). If that write leaves keyring_ciphertext
-- and keyring_epoch alone, the keyring stays sealed under a key that no longer exists, the
-- data keys become unreadable, and there is no copy to restore from.
-- public.enforce_keyring_epoch (20260831120000) accepts that write today: it has no clause
-- about the verifier. A client that predates envelope v3 can issue exactly that write
-- against a vault another client has already upgraded.
--
-- WHAT THIS CHANGES
-- Two clauses in the UPDATE branch of public.enforce_keyring_epoch, both raise check_violation.
--
-- Clause A, keyring erasure:
--   if the OLD row has a non-null keyring_ciphertext
--   and NEW.keyring_ciphertext is null
--   then raise, whatever keyring_epoch does.
-- Existing clause 3 only fires when the ciphertext is unchanged, so before this a write
-- that cleared the keyring and raised the epoch in the same statement was accepted. Nothing
-- legitimate does that: recovery and password change both re-seal a non-null keyring. A
-- vault born without a keyring (OLD null) may still carry NULL through unchanged.
--
-- Clause B, verifier:
--   if the OLD row has a non-null keyring_ciphertext
--   and NEW.vault_verifier_ciphertext differs from OLD
--   and NEW.keyring_epoch has not risen above OLD.keyring_epoch
--   then raise.
-- Because an epoch rise is already required to come with a re-sealed keyring_ciphertext
-- (existing clause 3), and clause A forbids that re-seal being a NULL, a verifier change
-- that raises the epoch is accepted only when a non-null keyring is re-sealed in the same
-- statement. That is the requirement.
--
-- WHAT STAYS ALLOWED
--   * A password change: it re-wraps the same vault key under a new password key and a new
--     recovery code. enc_mek_ciphertext and recovery_ciphertext change; the verifier and
--     the keyring do not. The new clause does not look at those two columns.
--   * A vault with no keyring (keyring_ciphertext null): the clause needs a non-null OLD
--     keyring, so an envelope v2 recovery is unchanged.
--   * The first keyring write on a vault that had none.
-- Everything else in the function is byte for byte the 20260831120000 body.
--
-- LIMIT, stated rather than overclaimed: clause B infers "the vault key changed" from "the
-- verifier was rewritten", because the server cannot see the vault key and the verifier
-- is the strongest signal it has.
--   * REQUIREMENT ON CLIENTS: a write that replaces the vault key must rewrite the
--     verifier in the same statement. The server relies on this and cannot check it.
--   * A write that replaces the key without touching the verifier is outside what this
--     guard can see; it is a violation of the requirement above, not something the
--     trigger detects.
--   * Harmless false positive: re-encrypting the verifier under the same key changes the
--     ciphertext, so the guard demands an epoch rise for what was a no-op rotation.
-- A plaintext generation counter was considered and not added: it is a new column and a
-- client change, and it still depends on the client bumping it.
-- Like the rest of this guard it constrains writes made through the application roles and
-- does not constrain table ownership or superuser.
--
-- SAFE TO RUN WHEN
-- Any time after 20260831071500 and 20260831120000 are applied. No row is read or written
-- by this file. It affects only future UPDATEs. The assertion block refuses to leave the
-- guard armed if either column the function reads at runtime is missing.
--
-- IDEMPOTENT. CREATE OR REPLACE FUNCTION; a re-run is a no-op. CREATE OR REPLACE keeps the
-- existing trigger attachment and its ENABLE ALWAYS mode, and the assertion block proves
-- the mode rather than assuming it.
--
-- REVERSIBLE. Re-run the CREATE OR REPLACE FUNCTION public.enforce_keyring_epoch() from
-- 20260831120000, which is the same function without the two IF blocks added here (the
-- keyring erasure block and the verifier block, the fourth and fifth of the UPDATE
-- branch). No data is touched either way.
--
-- Refs: OR-T0676, OR-T0967, OR-T1168

BEGIN;

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

    IF OLD.keyring_ciphertext IS NOT NULL
       AND NEW.keyring_ciphertext IS NULL THEN
      RAISE EXCEPTION 'keyring_ciphertext must not be cleared on a vault that holds a keyring (epoch % to %)', OLD.keyring_epoch, NEW.keyring_epoch
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.keyring_ciphertext IS NOT NULL
       AND NEW.vault_verifier_ciphertext IS DISTINCT FROM OLD.vault_verifier_ciphertext
       AND NEW.keyring_epoch <= OLD.keyring_epoch THEN
      RAISE EXCEPTION 'vault_verifier_ciphertext changed on a vault that holds a keyring without raising keyring_epoch (epoch stayed at %); a write that replaces the vault key must re-seal keyring_ciphertext and raise keyring_epoch in the same statement', OLD.keyring_epoch
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

-- Prove the result inside this transaction or abort. Each property is asserted by name:
-- an assertion that only checked "the function exists" would pass just as happily if the
-- new clause were missing, or if the trigger had been switched off.
DO $assert$
DECLARE
  v_secdef boolean; v_config text[]; v_src text;
  v_sp text; v_sp_parts text[];
  v_enabled "char"; v_def text;
BEGIN
  -- The function reads these two columns at runtime, so a missing column would leave
  -- vault writes failing long after the apply. Refuse here instead.
  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.user_vault_meta'::regclass AND attname = 'keyring_ciphertext'
     AND attnum > 0 AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: public.user_vault_meta has no keyring_ciphertext column; land 20260831071500 first';
  END IF;
  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'public.user_vault_meta'::regclass AND attname = 'keyring_epoch'
     AND attnum > 0 AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: public.user_vault_meta has no keyring_epoch column; land 20260831120000 first';
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_secdef, v_config, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_keyring_epoch';
  IF v_secdef IS NULL THEN RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch is missing'; END IF;
  IF NOT v_secdef THEN RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch must be SECURITY DEFINER'; END IF;

  SELECT c INTO v_sp FROM unnest(coalesce(v_config, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%';
  IF v_sp IS NULL THEN
    RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch must pin search_path, proconfig is %', coalesce(array_to_string(v_config, ','), '<null>');
  END IF;
  v_sp_parts := string_to_array(replace(split_part(v_sp, '=', 2), ' ', ''), ',');
  IF NOT ('public' = ANY(v_sp_parts)) OR v_sp_parts[array_length(v_sp_parts, 1)] <> 'pg_temp' THEN
    RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch must pin a search_path containing public and ending in pg_temp, got %', v_sp;
  END IF;

  -- The erasure clause: a non-null OLD keyring must not become NULL.
  IF position('NEW.keyring_ciphertext IS NULL' IN v_src) = 0
     OR position('must not be cleared on a vault that holds a keyring' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch does not carry the keyring erasure clause';
  END IF;

  -- The verifier clause: it must read the verifier and must refuse with check_violation.
  IF position('NEW.vault_verifier_ciphertext IS DISTINCT FROM OLD.vault_verifier_ciphertext' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: public.enforce_keyring_epoch does not carry the verifier clause';
  END IF;
  IF position('OLD.keyring_ciphertext IS NOT NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: the verifier clause must be limited to a vault that holds a keyring (OLD.keyring_ciphertext IS NOT NULL)';
  END IF;

  -- Enable mode, not only shape: pg_get_triggerdef does not carry it.
  SELECT tg.tgenabled, pg_get_triggerdef(tg.oid) INTO v_enabled, v_def
    FROM pg_trigger tg
   WHERE tg.tgrelid = 'public.user_vault_meta'::regclass AND tg.tgname = 'trg_keyring_epoch_guard';
  IF v_enabled IS NULL THEN RAISE EXCEPTION 'FAIL: trigger trg_keyring_epoch_guard is missing'; END IF;
  IF v_enabled <> 'A' THEN
    RAISE EXCEPTION 'FAIL: trg_keyring_epoch_guard must be ENABLE ALWAYS (tgenabled A), found %', v_enabled;
  END IF;
  IF v_def NOT ILIKE '%BEFORE INSERT OR UPDATE%' THEN
    RAISE EXCEPTION 'FAIL: trg_keyring_epoch_guard must be BEFORE INSERT OR UPDATE, got %', v_def;
  END IF;

  IF has_function_privilege('anon', 'public.enforce_keyring_epoch()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_keyring_epoch()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.enforce_keyring_epoch()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: application roles must not hold EXECUTE on public.enforce_keyring_epoch()';
  END IF;

  RAISE NOTICE 'OR-T0676 ok: enforce_keyring_epoch carries the erasure and verifier clauses, SECURITY DEFINER, search_path pinned ending in pg_temp, trigger ENABLE ALWAYS, no application role holds EXECUTE';
END $assert$;

COMMIT;
