-- OR-T1323: Add UPDATE RLS policy to public.encrypted_transactions
-- OR-T2011: hardened after review. The three OR-T2011 notes below say what
-- changed and why; nothing about the live databases changed.
--
-- The SELECT, INSERT and DELETE policies already exist. This adds the
-- matching UPDATE policy so authenticated users who own a connection
-- can update their own encrypted_transactions rows.
--
-- The policy expression is identical to the existing SELECT and DELETE
-- policies: scoped to the user's own connections via subaccounts on
-- the direct platform.
--
-- OR-T2011 (1), correction of a false statement. This header used to read
-- "On prod the policy is absent and will be created". That was not true.
-- Measured 2026-09-03 by reading pg_policy on both projects: dev
-- (fzwmnzmtqidumdqjdddz) and prod (lcdicqalreskibdfxkzb) each carry all
-- four policies on this table, and every one of the four expressions
-- hashes to 7db97b20d0ba361d129b8ea7eae9755d. The apply is a no-op on
-- both. This file only does work on a cluster that does not carry the
-- policy at all (a fresh project, a restore) or carries it with a
-- different definition.
--
-- OR-T2011 (2), the guard is gone on purpose, do not put it back. The
-- creation below used to be wrapped in "if not exists (select 1 from
-- pg_policy ...)". On a cluster already carrying this policy under a
-- DIFFERENT definition, that guard skipped the create and the verification
-- block at the bottom then raised on the mismatch: definition drift turned
-- into a stopped deploy pipeline rather than into a correction. DROP POLICY
-- IF EXISTS followed by CREATE POLICY corrects the drift instead. Both
-- statements sit inside ONE do block, and a do block is a single SQL
-- statement, so they are atomic whatever the runner does: there is no
-- window in which this table has no UPDATE policy.
--
-- Verification asserts (a) the UPDATE policy exists with polcmd=w
-- TO authenticated, and (b) its USING and WITH CHECK expressions
-- hash-equal the SELECT policy USING expression. Any divergence raises
-- immediately rather than silently certifying a mismatch.

do $$
begin
  drop policy if exists "Direct users can update transactions via their subaccount"
    on public.encrypted_transactions;

  create policy "Direct users can update transactions via their subaccount"
    on public.encrypted_transactions
    for update
    to authenticated
    using (
      connection_id in (
        select c.id from public.connections c
          join public.subaccounts s on s.id = c.subaccount_id
          join public.platforms p on p.id = s.platform_id and p.slug = 'direct'
         where s.external_user_id = (auth.uid())::text
      )
    )
    with check (
      connection_id in (
        select c.id from public.connections c
          join public.subaccounts s on s.id = c.subaccount_id
          join public.platforms p on p.id = s.platform_id and p.slug = 'direct'
         where s.external_user_id = (auth.uid())::text
      )
    );
end $$;

-- Verification: fails loud if policy absent, not TO authenticated, or
-- expressions diverge from the reference SELECT policy on the same table.
do $$
declare
  update_pol_oid    oid;
  select_pol_oid    oid;
  update_qual_hash  text;
  update_check_hash text;
  select_qual_hash  text;
begin
  -- (a) UPDATE policy must exist with polcmd='w'
  select pol.oid into update_pol_oid
    from pg_policy pol
    join pg_class cl on cl.oid = pol.polrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'encrypted_transactions'
     and pol.polname = 'Direct users can update transactions via their subaccount'
     and pol.polcmd = 'w';

  if update_pol_oid is null then
    raise exception
      'VERIFY FAILED (OR-T1323): UPDATE policy missing on public.encrypted_transactions';
  end if;

  -- (a) must be granted TO authenticated specifically
  if not exists (
    select 1 from pg_policy
     where oid = update_pol_oid
       and polroles @> array[('authenticated'::regrole)::oid]
  ) then
    raise exception
      'VERIFY FAILED (OR-T1323): UPDATE policy is not granted TO authenticated';
  end if;

  -- (b) locate the reference SELECT policy, BY EXACT NAME.
  --
  -- OR-T2011 (3). This was "and pol.polname like 'Direct users%' limit 1"
  -- with no ORDER BY. All four policies on this table already use the
  -- 'Direct users can ... transactions via their subaccount' convention, so
  -- a second SELECT policy under that convention is an ordinary future
  -- change. From the moment there are two, the reference is whichever row
  -- the planner returns first, which can differ between clusters and between
  -- runs, and this gate could then raise on a database that is correct.
  -- Postgres guarantees policy names are unique per table, so naming the
  -- policy exactly is deterministic by construction. Do not loosen it back
  -- to a prefix match: if this policy is ever renamed, the raise below is
  -- the right outcome and the fix is to update this name, not to guess.
  select pol.oid into select_pol_oid
    from pg_policy pol
    join pg_class cl on cl.oid = pol.polrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'encrypted_transactions'
     and pol.polcmd = 'r'
     and pol.polname = 'Direct users can read transactions via their subaccount';

  if select_pol_oid is null then
    raise exception
      'VERIFY FAILED (OR-T1323): reference SELECT policy "Direct users can read transactions via their subaccount" not found on public.encrypted_transactions';
  end if;

  -- (b) USING and WITH CHECK must hash-equal the SELECT USING expression
  select md5(pg_get_expr(polqual, polrelid)) into update_qual_hash
    from pg_policy where oid = update_pol_oid;
  select md5(pg_get_expr(polwithcheck, polrelid)) into update_check_hash
    from pg_policy where oid = update_pol_oid;
  select md5(pg_get_expr(polqual, polrelid)) into select_qual_hash
    from pg_policy where oid = select_pol_oid;

  if update_qual_hash is distinct from select_qual_hash then
    raise exception
      'VERIFY FAILED (OR-T1323): UPDATE USING hash (%) does not match SELECT USING hash (%)',
      update_qual_hash, select_qual_hash;
  end if;

  if update_check_hash is distinct from select_qual_hash then
    raise exception
      'VERIFY FAILED (OR-T1323): UPDATE WITH CHECK hash (%) does not match SELECT USING hash (%)',
      update_check_hash, select_qual_hash;
  end if;
end $$;
