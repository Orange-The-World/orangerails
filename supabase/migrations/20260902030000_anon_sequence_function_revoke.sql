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

  -- A4. The precondition that makes leaving the supabase_admin default
  -- alone safe: it must own zero relations and zero functions in public. If
  -- this fires, that precondition no longer holds and the unreachable
  -- default is reachable after all; do not just widen this assertion.
  select string_agg(format('relation %s', c.relname), ', ' order by c.relname)
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
   where n.nspname = 'public'
     and r.rolname = 'supabase_admin';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: supabase_admin owns object(s) in public, the untouched default is reachable: %', v_bad;
  end if;

  select string_agg(format('function %s', p.proname), ', ' order by p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname = 'public'
     and r.rolname = 'supabase_admin';
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: supabase_admin owns object(s) in public, the untouched default is reachable: %', v_bad;
  end if;

  raise notice 'anon sequence/function sweep: end state verified. No sequence or function grant for anon in schema public, and the postgres default privilege no longer grants one.';
end $$;
