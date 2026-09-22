-- Assertion helpers for the user_vault_meta RLS suite (OR-T0690).
--
-- Loaded AFTER the migration, not with the bootstrap, because it is only
-- useful once public.user_vault_meta exists.

-- Switch the session to look like a real signed-in PostgREST/Supabase
-- request from the given user: current_user becomes the non-owner,
-- non-superuser "authenticated" role (so ownership and superuser RLS
-- bypasses do not apply), and auth.uid() starts returning p_user_id.
--
-- SET ROLE (not SET LOCAL) so it holds across the statements a test issues,
-- the same way a real request's role and JWT claim both hold for the
-- request's duration.
CREATE OR REPLACE FUNCTION public.t_set_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE 'SET ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', p_user_id::text, false);
END;
$$;

-- Back to the setup role: RESET ROLE returns current_user to whatever
-- connected (postgres, a superuser, which bypasses RLS), and clearing the
-- claim makes auth.uid() behave like a signed-out session again.
CREATE OR REPLACE FUNCTION public.t_reset_user()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', false);
END;
$$;

-- Run, as p_as_user, an UPDATE of public.user_vault_meta.vault_key_version
-- (bumped by 1, a real column write, not a no-op) for the row owned by
-- p_target_row, and assert it affected exactly p_expected row(s).
--
-- Always resets back to the setup role before returning, including on
-- failure, so one failed assertion cannot leave a later assertion running
-- under the wrong session state.
CREATE OR REPLACE FUNCTION public.t_assert_update_count(
  p_label       text,
  p_as_user     uuid,
  p_target_row  uuid,
  p_expected    int
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.t_set_user(p_as_user);

  UPDATE public.user_vault_meta
     SET vault_key_version = vault_key_version + 1
   WHERE user_id = p_target_row;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.t_reset_user();

  IF v_count <> p_expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED [%]: expected % row(s) affected, got %',
      p_label, p_expected, v_count;
  END IF;
  RAISE NOTICE 'ok  %  ->  % row(s) affected (expected %)', p_label, v_count, p_expected;

EXCEPTION WHEN OTHERS THEN
  -- Belt and braces: if the UPDATE itself raised (rather than just
  -- affecting zero rows), still leave the session in the setup role before
  -- re-raising, so the harness self-test below is not itself the thing that
  -- leaves a later step running as "authenticated".
  PERFORM public.t_reset_user();
  RAISE;
END;
$$;
