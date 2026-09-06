-- Revoke anon privileges on SEQUENCES and FUNCTIONS in schema public, and
-- close the matching default privileges so a new sequence or function does
-- not arrive with the same grant.
--
-- See the commit message for the full write-up (why this is separate from
-- PR #1091, what was measured on dev and prod, and what this deliberately
-- does not touch). In short: #1091 only guards relkind 'r'/'p' (tables) and
-- defaclobjtype 'r'. This file closes the same door for relkind 'S'
-- (sequences) and pg_proc / defaclobjtype 'f' and 'S' (functions).
--
--
-- The objtype 'f' (function) default is revoked here deliberately (see PART 3 and
-- assertions A3/A5). Three quarters of the functions in schema public run SECURITY
-- DEFINER, so RLS does not constrain them, and an open 'f' default hands anon EXECUTE
-- on every future function postgres creates in public with no review anywhere. If a
-- future migration needs an anon-callable RPC, it must add its own explicit
-- GRANT EXECUTE ON FUNCTION <fn> TO anon line; that grant does not come back on its own.
--
-- ---------------------------------------------------------------------------
-- PART 1: every sequence in schema public loses every anon privilege.
-- Resolves dynamically at apply time, so an empty set of sequences is a
-- clean no-op rather than an error; no to_regclass guard is needed here the
-- way PR #1091 needed one for its named table list.
-- ---------------------------------------------------------------------------

revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------------------
-- PART 2: every function in schema public loses every anon privilege.
-- ---------------------------------------------------------------------------

revoke all on all functions in schema public from anon;

-- ---------------------------------------------------------------------------
-- PART 3: stop the tap for both object types. FOR ROLE postgres is load
-- bearing, the same way it was in #1091: default privileges are per owning
-- role and this does nothing for objects created by any other role. The
-- supabase_admin-owned default is a separate, deliberately untouched case,
-- see the commit message and assertion A3 below.
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke all on sequences from anon;

alter default privileges for role postgres in schema public
  revoke all on functions from anon;

-- ---------------------------------------------------------------------------
-- PART 4: assert the END STATE, not the change. aclexplode over the
-- catalogue, in the same style as PR #1091's Part 4, so a privilege nobody
-- thought of is caught too and the failure names the offending object.
--
-- WHAT THIS BLOCK DOES NOT COVER, stated here so nobody reads it as continuous
-- coverage. Everything below runs at APPLY time and only at apply time. It
-- catches a rebuilt environment that never reached the target state, and a
-- later migration that undoes this one, because both are followed by an apply
-- of this file. It does NOT catch a Supabase platform migration overwriting our
-- default-ACL row BETWEEN two of our applies: nothing of ours runs at that
-- moment, so nothing of ours can notice. The continuous half is the
-- object-level drift fingerprint, which folds these default ACLs and the two
-- ownership counts into a comparison that runs on its own schedule.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- A1. No sequence in schema public may hold any privilege for anon.
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ' order by c.relname, a.privilege_type)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and c.relkind = 'S'
     and c.relacl is not null
     and r.rolname = 'anon';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: sequence still holds a grant for anon: %', v_bad;
  end if;

  -- A2. No function in schema public may hold a direct privilege for anon.
  select string_agg(format('%s:%s', p.proname, a.privilege_type), ', ' order by p.proname, a.privilege_type)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and p.proacl is not null
     and r.rolname = 'anon';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: function still holds a grant for anon: %', v_bad;
  end if;

  -- A3. The postgres-owned default privilege must no longer hand out a
  -- sequence or function grant to anon on new objects.
  select string_agg(format('%s:%s', d.defaclobjtype, a.privilege_type), ', ' order by d.defaclobjtype, a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and d.defaclobjtype in ('S', 'f')
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and r.rolname = 'anon';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: default privileges for role postgres still grant anon: %', v_bad;
  end if;

  -- A4, standing assertion A. The precondition that makes leaving the
  -- supabase_admin default alone safe: it must own zero relations and zero
  -- functions in public. Those default-ACL rows cannot be changed by any role
  -- we hold, and they cannot fire only because every relation and every
  -- function in public is owned by postgres. That second half is the whole
  -- compensating control and nothing else checks that it stays true. If this
  -- fires, the precondition no longer holds: the unreachable default is
  -- reachable after all, and the next object supabase_admin creates in public
  -- arrives with a full write grant for anon. Do not widen this assertion to
  -- make it pass.
  select string_agg(format('relation %s', c.relname), ', ' order by c.relname)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
   where n.nspname = 'public'
     and r.rolname = 'supabase_admin';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: supabase_admin owns relation(s) in schema public, so its still-open default ACL is reachable after all and a table it creates would arrive granting anon the full owner-shaped write set: %', v_bad;
  end if;

  select string_agg(format('function %s', p.proname), ', ' order by p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname = 'public'
     and r.rolname = 'supabase_admin';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: supabase_admin owns function(s) in schema public, so its still-open default ACL is reachable after all and a function it creates would arrive granting anon EXECUTE: %', v_bad;
  end if;

  -- A5, standing assertion B. Our own default-ACL fix must still be the one in
  -- force. Our row and a Supabase platform-written row are the same kind of
  -- object, so a platform migration can overwrite ours and nothing else would
  -- say so. This asserts the CONTENT of the postgres-owned default for all
  -- three object types rather than the row count: objtype 'r' must read anon=r,
  -- and objtypes 'S' and 'f' must not mention anon at all. A row that exists
  -- with the wrong ACL fails here, and so does a row that has vanished, because
  -- a vanished row means ours is no longer the one in force. It deliberately
  -- restates A3's S and f half so that this reads as one complete statement of
  -- the target state instead of two halves in different places.
  select string_agg(format('%s:%s', d.defaclobjtype, a.privilege_type), ', ' order by d.defaclobjtype, a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
   where n.nspname = 'public'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and r.rolname = 'anon'
     and (d.defaclobjtype in ('S', 'f')
          or (d.defaclobjtype = 'r' and a.privilege_type <> 'SELECT'));
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: the postgres default privilege in schema public grants anon more than SELECT on tables, or grants it anything at all on sequences or functions. Our default ACL has been overwritten: %', v_bad;
  end if;

  -- The positive half of A5. The tables default must still carry anon=r. A
  -- default ACL that is gone entirely is not a safe state to pass silently: it
  -- means the row we wrote is not the one in force, and reads through the
  -- anonymous role stop working on any table created after that point.
  if not exists (
       select 1
         from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace
         cross join lateral aclexplode(d.defaclacl) a
         join pg_roles r on r.oid = a.grantee
        where n.nspname = 'public'
          and d.defaclobjtype = 'r'
          and pg_get_userbyid(d.defaclrole) = 'postgres'
          and r.rolname = 'anon'
          and a.privilege_type = 'SELECT'
     ) then
    raise exception 'anon sequence/function sweep FAILED: the postgres default privilege for TABLES in schema public no longer grants anon SELECT. The row was either overwritten or removed, so the default ACL in force is not ours. Expected objtype r to read anon=r.';
  end if;

  -- A6, ported from PR #1095's assertion (e). anon's two legitimate INSERT paths must
  -- survive this sweep untouched: neither waitlist nor adapter_requests uses an
  -- identity column or a nextval default (both use gen_random_uuid() primary keys), so
  -- this file has no reason to ever touch either grant, but every other assertion here
  -- is an allow-list that only fires on a privilege being PRESENT for anon, so an
  -- over-revoke on these two tables would otherwise pass silently.
  if not has_table_privilege('anon', 'public.waitlist', 'INSERT') then
    raise exception 'anon sequence/function sweep FAILED: anon lost INSERT on public.waitlist; this file must never touch that grant';
  end if;
  if not has_table_privilege('anon', 'public.adapter_requests', 'INSERT') then
    raise exception 'anon sequence/function sweep FAILED: anon lost INSERT on public.adapter_requests; this file must never touch that grant';
  end if;

  raise notice 'anon sequence/function sweep: end state verified. No sequence or function grant for anon in schema public, the postgres default privilege no longer grants one, the postgres default ACL still reads anon=r on tables and names anon nowhere for sequences or functions, and anon still holds its two legitimate INSERT paths.';
end $$;
