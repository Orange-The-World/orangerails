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
-- PART 2: every function in schema public loses every anon privilege and
-- every PUBLIC privilege.
--
-- Two separate revokes are required. REVOKE FROM anon removes any explicit
-- direct grant to anon, but in PostgreSQL 16 a function whose proacl is NULL
-- (the default for postgres-owned functions) is still executable by PUBLIC,
-- and anon is a member of PUBLIC. REVOKE FROM PUBLIC closes that second route.
-- Without this second revoke, has_function_privilege('anon', fn, 'EXECUTE')
-- returns true even after the anon-specific revoke.
-- ---------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke execute on all functions in schema public from public;

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

-- Also revoke from PUBLIC so that a function postgres creates after this
-- migration has proacl that excludes PUBLIC execute. Without this, ALTER DEFAULT
-- PRIVILEGES FOR anon produces no pg_default_acl row on a clean database (nothing
-- to revoke), and newly created functions still start with proacl NULL = PUBLIC
-- execute, meaning anon can still call them through PUBLIC group membership.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

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

  -- A2. No function in schema public may be executable by anon via any path:
  -- explicit grant, PUBLIC inheritance, or NULL proacl (which means PUBLIC has
  -- execute by default in PostgreSQL 16). Using has_function_privilege captures
  -- all three; the prior aclexplode-only approach missed NULL/bare-PUBLIC cases
  -- because it filtered on proacl IS NOT NULL, making it blind to the common
  -- case where a postgres-owned function has proacl NULL and anon reaches
  -- execute through PUBLIC group membership.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: anon can still execute function(s) in schema public (via any path including PUBLIC inheritance or NULL proacl): %', v_bad;
  end if;

  -- A3. The postgres-owned default privilege must no longer hand out a
  -- sequence or function grant to anon OR to PUBLIC (grantee OID 0 in
  -- pg_default_acl / aclexplode). The prior version joined pg_roles on
  -- a.grantee, which silently excluded the PUBLIC pseudo-role because oid=0
  -- has no row in pg_roles. That made A3 blind to a bare-PUBLIC default grant,
  -- which is exactly the gap PART 3's second revoke closes. Fixed here by
  -- dropping the join and matching grantee directly.
  select string_agg(format('%s:%s->%s', d.defaclobjtype,
           case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           a.privilege_type), ', ' order by d.defaclobjtype, a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
   where n.nspname = 'public'
     and d.defaclobjtype in ('S', 'f')
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and (a.grantee = 0 or pg_get_userbyid(a.grantee) = 'anon');
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: default privileges for role postgres still grant anon or PUBLIC something on sequences or functions: %', v_bad;
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

  -- A5, standing assertion B. After 20260906120000 revoked the postgres table
  -- default entirely (including anon SELECT), the target state for all three
  -- object types is: neither anon nor PUBLIC must appear in the postgres-owned
  -- default ACL for 'r', 'S', or 'f'. The prior version joined pg_roles on
  -- a.grantee, which silently excluded the PUBLIC pseudo-role (grantee OID 0).
  -- Fixed here by dropping the join and matching grantee directly, covering
  -- both the direct-anon and bare-PUBLIC cases in one query.
  select string_agg(format('%s:%s->%s', d.defaclobjtype,
           case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           a.privilege_type), ', ' order by d.defaclobjtype, a.privilege_type)
    into v_bad
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
   where n.nspname = 'public'
     and pg_get_userbyid(d.defaclrole) = 'postgres'
     and (a.grantee = 0 or pg_get_userbyid(a.grantee) = 'anon')
     and d.defaclobjtype in ('r', 'S', 'f');
  if v_bad is not null then
    raise exception 'anon sequence/function sweep FAILED: the postgres default privilege in schema public still grants anon or PUBLIC something on tables, sequences, or functions. Expected none after 20260906120000 revoked the table default: %', v_bad;
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

  raise notice 'anon sequence/function sweep: end state verified. No sequence or function grant for anon or PUBLIC in schema public, the postgres default privilege names neither anon nor PUBLIC for tables, sequences, or functions (table default also revoked by 20260906120000), and anon still holds its two legitimate INSERT paths.';
end $$;
