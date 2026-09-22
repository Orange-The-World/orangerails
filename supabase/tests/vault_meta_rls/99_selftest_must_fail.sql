-- Harness self-test for the user_vault_meta RLS suite (OR-T0690).
-- This file is SUPPOSED TO FAIL. The CI step wrapping it treats a clean
-- exit as the error.
--
-- Asserts that user A updating user B's row affects ONE row. That is known
-- false: 10_rls_assertions.sql already proved it affects zero. If this ever
-- reports OK, the assertion helper itself is broken (for example, t_set_user
-- silently failing to switch roles so every UPDATE runs as the RLS-bypassing
-- setup role), and every green result in this suite up to this point would
-- be meaningless.
SELECT public.t_assert_update_count(
  'SELFTEST (must fail): user A updating user B row must NOT report 1',
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  1
);
