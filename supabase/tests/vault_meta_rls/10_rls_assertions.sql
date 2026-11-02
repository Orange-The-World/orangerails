-- Behavioural RLS assertions for public.user_vault_meta (OR-T0690).
--
-- Two users, two rows, inserted as the setup role so the INSERT policy is
-- not what is under test here. What is under test is the UPDATE policy:
--   CREATE POLICY "Users can update own vault metadata"
--     ON public.user_vault_meta FOR UPDATE TO authenticated
--     USING (user_id = auth.uid());
-- which has a USING expression and no WITH CHECK. DL-1958 (the CTO)
-- declined a separate ticket on the grounds that Postgres applies the
-- USING expression to the new row too when no WITH CHECK is given. That is
-- correct as documentation. These assertions are what make it a checked
-- fact about this database rather than a citation of the manual.

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2');

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'test-salt-a1', 'test-verifier-a1'),
  ('00000000-0000-0000-0000-0000000000a2', 'test-salt-a2', 'test-verifier-a2');

-- THE ACCEPTANCE CRITERION: user A (...a1) attempts to update user B's
-- (...a2) row. Zero rows affected.
SELECT public.t_assert_update_count(
  'user A cannot update user B row',
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  0
);

-- THE CONTROL, and it matters as much as the assertion above: user B
-- updates their OWN row. One row affected. If this were also 0, the first
-- assertion would be worthless -- it would mean the whole statement is
-- broken for some other reason, not that row level security is working.
SELECT public.t_assert_update_count(
  'user B (owner) can update own row',
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  1
);

-- A second, symmetric instance of both cases with the users swapped, so the
-- result does not depend on which literal happens to sort first or second
-- in the table.
SELECT public.t_assert_update_count(
  'user B cannot update user A row',
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  0
);

SELECT public.t_assert_update_count(
  'user A (owner) can update own row',
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  1
);

-- THE GAP THE AUDITOR NAMED IN REVIEW, 2026-09-23: every assertion above
-- only bumps vault_key_version, so none of them observes the actual
-- DL-1958 question, whether the missing WITH CHECK stops a user from
-- reassigning ROW OWNERSHIP itself by writing a new user_id. Per the
-- Postgres manual, a missing WITH CHECK reuses USING against the NEW row:
-- the pre-image check passes (the row genuinely is the caller's own), but
-- the post-image check evaluates user_id = auth.uid() against the row AS
-- IT WOULD APPEAR after the update, and the caller's session identity
-- (auth.uid()) does not change just because the row's user_id column does.
-- So the new row's user_id no longer equals auth.uid(), the check fails,
-- and Postgres aborts the whole UPDATE.
--
-- User C (...a3) deliberately has NO row in user_vault_meta. That isolates
-- the RLS question from an incidental PRIMARY KEY collision: user_id is
-- this table's primary key, so reassigning to a user who already has a row
-- would also trip a unique-constraint violation, refused for a reason that
-- has nothing to do with row level security. Reassigning to a user with no
-- existing row means RLS is the only thing that can refuse it.
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000a3');

SELECT public.t_assert_reassign_outcome(
  'user A cannot reassign own row to user C (no vault row) via user_id',
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '00000000-0000-0000-0000-0000000000a3'::uuid,
  true
);

SELECT public.t_assert_reassign_outcome(
  'user B cannot reassign own row to user C (no vault row) via user_id',
  '00000000-0000-0000-0000-0000000000a2'::uuid,
  '00000000-0000-0000-0000-0000000000a3'::uuid,
  true
);
