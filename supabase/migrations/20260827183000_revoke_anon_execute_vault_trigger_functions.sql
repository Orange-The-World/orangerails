-- Revoke EXECUTE from anon on the last five anon-executable functions in public.
--
-- MEASURED, not assumed. On 2026-08-27, has_function_privilege on dev reported exactly five
-- functions in the public schema still executable by anon. All five are listed below, all five
-- return trigger, and all five belong to the vault write-once family.
--
-- NOBODY GRANTED THIS. There is no GRANT statement for any of them in any migration. Each one
-- inherited EXECUTE from the schema's default privileges at CREATE FUNCTION time. That is the
-- grant that appears in no SQL, and it is why a clean source scan and an anon-executable
-- database were consistent with each other.
--
-- THE CLAIM THIS FILE RESTS ON, AND HOW IT WAS CHECKED. Revoking EXECUTE on a trigger-returning
-- function is expected to change nothing: the trigger machinery invokes the function and does
-- not consult EXECUTE at fire time, and PostgREST will not expose a trigger-returning function
-- as an RPC, so there is no caller to break. Expected is not checked, so it was checked on dev
-- before this file existed. A throwaway write-once trigger was built in a scratch schema,
-- EXECUTE was revoked from PUBLIC, anon and authenticated, and the second write was STILL
-- rejected by the trigger while anon EXECUTE read false. Both halves had to hold or the test
-- raised. The scratch schema was then dropped and its absence confirmed.
--
-- WHAT THIS FILE MUST NOT BECOME. A blanket revoke of authenticated across the schema.
-- 20260723190000 states that authenticated must KEEP EXECUTE on create_or_access_token(text)
-- and is_staff(), and both hold it on dev today. Neither is named here. Both must still read
-- authenticated true after this applies, and that read-back is part of accepting this change.
--
-- Every revoke names PUBLIC, anon AND authenticated. A revoke naming only PUBLIC leaves the
-- access entry made to anon exactly where it was, because Postgres stores them separately.
-- That is the defect this whole line of work exists to close.

revoke all on function public.enforce_customer_vault_pubkey_write_once()
  from public, anon, authenticated;

revoke all on function public.enforce_vault_meta_no_direct_delete()
  from public, anon, authenticated;

revoke all on function public.enforce_vault_pubkey_write_once()
  from public, anon, authenticated;

revoke all on function public.fn_uvp_pubkey_immutable()
  from public, anon, authenticated;

revoke all on function public.vault_key_version_must_not_decrease()
  from public, anon, authenticated;

-- Prove the file did what it says, in the same transaction that says it. A migration that
-- applies cleanly is not evidence that the privilege moved: the revoke could name a function
-- that no longer exists under that signature, or a later grant could put it back. This block
-- reads the privilege back and refuses to commit if any of the five is still executable by anon
-- or by authenticated.
do $verify$
declare
  v_fn    text;
  v_left  text[] := '{}';
begin
  foreach v_fn in array array[
    'public.enforce_customer_vault_pubkey_write_once()',
    'public.enforce_vault_meta_no_direct_delete()',
    'public.enforce_vault_pubkey_write_once()',
    'public.fn_uvp_pubkey_immutable()',
    'public.vault_key_version_must_not_decrease()'
  ]
  loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_left := v_left || v_fn;
    end if;
  end loop;

  if array_length(v_left, 1) is not null then
    raise exception
      'revoke did not take: % is still executable by anon or authenticated. Nothing committed.',
      array_to_string(v_left, ', ')
      using errcode = 'P0001';
  end if;

  -- The other direction, and it is the one that breaks a screen if it is wrong. These two must
  -- KEEP authenticated EXECUTE. If this migration ever grows into a blanket revoke, this is
  -- what stops it shipping.
  if not has_function_privilege('authenticated', 'public.create_or_access_token(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_staff()', 'EXECUTE') then
    raise exception
      'create_or_access_token(text) or is_staff() lost authenticated EXECUTE. 20260723190000 '
      'requires both to keep it and the API tokens screen depends on them. Nothing committed.'
      using errcode = 'P0001';
  end if;

  raise notice
    'anon EXECUTE closed on 5 of 5 vault trigger functions; authenticated EXECUTE retained on '
    'create_or_access_token(text) and is_staff().';
end;
$verify$;
