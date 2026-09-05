-- OR-T1323: Add UPDATE RLS policy to public.encrypted_transactions
--
-- The SELECT, INSERT and DELETE policies already exist. This adds the
-- matching UPDATE policy so authenticated users who own a connection
-- can update their own encrypted_transactions rows.
--
-- The policy expression is identical to the existing SELECT and DELETE
-- policies: scoped to the user's own connections via subaccounts on
-- the direct platform.
--
-- The DO block is guarded: the policy already exists on dev (applied
-- by hand under OR-T1317) so the apply there is a no-op. On prod the
-- policy is absent and will be created. Do not remove the guard.
--
-- Verification asserts (a) the UPDATE policy exists with polcmd=w
-- TO authenticated, and (b) its USING and WITH CHECK expressions
-- hash-equal the SELECT policy USING expression. Any divergence raises
-- immediately rather than silently certifying a mismatch.

do $$
begin
  if not exists (
    select 1
      from pg_policy pol
      join pg_class cl on cl.oid = pol.polrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relname = 'encrypted_transactions'
       and pol.polname = 'Direct users can update transactions via their subaccount'
  ) then
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
  end if;
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

  -- (b) locate the reference SELECT policy
  select pol.oid into select_pol_oid
    from pg_policy pol
    join pg_class cl on cl.oid = pol.polrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'encrypted_transactions'
     and pol.polcmd = 'r'
     and pol.polname like 'Direct users%'
   limit 1;

  if select_pol_oid is null then
    raise exception
      'VERIFY FAILED (OR-T1323): reference SELECT policy not found on public.encrypted_transactions';
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
