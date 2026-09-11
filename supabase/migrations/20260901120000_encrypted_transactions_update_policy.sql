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

do $$
declare
  upd_polcmd char;
  upd_polroles oid[];
  upd_qual text;
  upd_check text;
  sel_qual text;
  auth_oid oid;
begin
  select pol.polcmd, pol.polroles,
         pg_get_expr(pol.polqual, pol.polrelid),
         pg_get_expr(pol.polwithcheck, pol.polrelid)
    into upd_polcmd, upd_polroles, upd_qual, upd_check
    from pg_policy pol
    join pg_class cl on cl.oid = pol.polrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'encrypted_transactions'
     and pol.polname = 'Direct users can update transactions via their subaccount';

  if upd_polcmd is null then
    raise exception 'verification failed: no policy named "Direct users can update transactions via their subaccount" found on public.encrypted_transactions';
  end if;

  if upd_polcmd <> 'w' then
    raise exception 'verification failed: found the policy but polcmd=% (expected w for UPDATE)', upd_polcmd;
  end if;

  select oid into auth_oid from pg_roles where rolname = 'authenticated';

  if auth_oid is null or not (auth_oid = any(upd_polroles)) then
    raise exception 'verification failed: policy is not scoped TO authenticated (polroles=%)', upd_polroles;
  end if;

  select pg_get_expr(pol.polqual, pol.polrelid)
    into sel_qual
    from pg_policy pol
    join pg_class cl on cl.oid = pol.polrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'encrypted_transactions'
     and pol.polname = 'Direct users can read transactions via their subaccount';

  if sel_qual is null then
    raise exception 'verification failed: could not find the existing SELECT policy to compare against';
  end if;

  if md5(upd_qual) is distinct from md5(sel_qual) then
    raise exception 'verification failed: UPDATE policy USING clause hash % does not match SELECT policy USING clause hash %', md5(upd_qual), md5(sel_qual);
  end if;

  if md5(upd_check) is distinct from md5(sel_qual) then
    raise exception 'verification failed: UPDATE policy WITH CHECK clause hash % does not match SELECT policy USING clause hash %', md5(upd_check), md5(sel_qual);
  end if;
end $$;
