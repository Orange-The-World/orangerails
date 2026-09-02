-- Make the ANONYMOUS role's half of the default privilege taps in schema public
-- VISIBLE on every apply. This file grants nothing, revokes nothing and alters
-- nothing. It reads pg_default_acl and raises a warning. If you came here
-- looking for the statement that fixes the condition, there is none, and the
-- reason is written out below rather than left for you to rediscover.
--
-- WHY THIS IS ITS OWN FILE AND NOT A LINE IN
-- 20260903013000_authenticated_maintenance_privilege_revoke.sql. That file says,
-- in its header and again in the scope note on its B2 block, that the anonymous
-- role is a separate concern with its own change. This is that change. Three
-- further reasons, recorded so nobody folds it back in later:
--   1. The shape is not the same. That file's loop filters catalogue object type
--      'r' and the four maintenance privileges. The anonymous exposure measured
--      here spans THREE object types and, on tables, all eight privileges.
--      Reusing that predicate would report a misleadingly narrow subset of it.
--   2. That file is the subject of two open pull requests at the time of
--      writing, both editing the same B2 block. A third edit to the same lines
--      is a merge conflict, not a contribution.
--   3. Its assertions are all about the logged-in role. Mixing a second grantee
--      into them makes a future failure message ambiguous about which role it is
--      talking about, which is the property that makes those messages useful.
--
-- WHAT WAS MEASURED, live on the development cluster on 2026-09-02, with
-- aclexplode over pg_default_acl for schema public, grantee anon:
--     postgres        object type r  ->  SELECT
--     supabase_admin  object type r  ->  DELETE, INSERT, MAINTAIN, REFERENCES,
--                                        SELECT, TRIGGER, TRUNCATE, UPDATE
--     supabase_admin  object type S  ->  SELECT, UPDATE, USAGE
--     supabase_admin  object type f  ->  EXECUTE
--
-- READ THE supabase_admin LINES. Under the postgres tap the anonymous role gets
-- SELECT on a new table and nothing at all on a new sequence or function, which
-- is the intended shape. Under the supabase_admin tap it gets every privilege on
-- a new table, INSERT, UPDATE, DELETE and TRUNCATE included, plus USAGE, SELECT
-- and UPDATE on a new sequence and EXECUTE on a new function. So a table created
-- in schema public by that role on that cluster arrives WRITABLE by an anonymous
-- session, with row level security the only thing left standing in front of it.
--
-- THE SEQUENCE AND FUNCTION HALF IS NEW relative to the finding that asked for
-- this file, which measured object type r only. It is worth naming separately
-- because the anonymous sweep over sequences and functions is its own piece of
-- work, and a tap that re-grants on every newly created object makes that sweep
-- a point in time cleanup rather than a durable state on this cluster.
--
-- IT IS LATENT TODAY, NOT LIVE, AND THIS FILE SAYS WHICH RATHER THAN ASSUMING.
-- Measured the same day: zero of the 52 tables in schema public are owned by
-- supabase_admin, and it owns no sequences or functions there either. The loop
-- below counts the objects each tap's owning role actually holds in the schema
-- and prints LATENT or LIVE accordingly, so the reader does not have to go and
-- check before knowing how much to care.
--
-- NO MIGRATION CAN CLOSE IT, so do not add a statement that tries. ALTER DEFAULT
-- PRIVILEGES FOR ROLE supabase_admin is permitted only to that role or a member
-- of it. Measured on this cluster: select current_user,
-- pg_has_role(current_user, 'supabase_admin', 'MEMBER') returns postgres and
-- false, and postgres is not a superuser on this platform. A statement that
-- tries is refused, and the refusal aborts the whole deploy. Closing it is a
-- Supabase platform request.
--
-- SCOPE, DELIBERATELY NARROW. The loop reports only taps the APPLYING ROLE
-- CANNOT NARROW, expressed as pg_has_role(current_user, owner, 'MEMBER') being
-- false. A tap owned by a role the applying role belongs to IS closeable by a
-- migration, and which of those should be closed is owned by the anonymous sweep
-- work, not by a visibility file. Reporting them here would put a permanent
-- warning on the deploy log for a condition somebody else is deliberately
-- holding open, and a warning that is always there is a warning nobody reads.
-- Verified on the development cluster: this predicate excludes the postgres tap
-- and returns exactly the three supabase_admin rows above.
--
-- WHY IT WARNS AND DOES NOT RAISE. The condition cannot be repaired by any
-- migration, so an exception would abort every future deploy on something no
-- file is allowed to fix. A tap nobody can close should still be a tap nobody
-- can miss.
--
-- WHAT THIS IS NOT, stated plainly so it is not over-read. It is visibility, not
-- enforcement. A warning is seen only by whoever reads that apply's log, and it
-- runs only at apply time, so a platform change made between two applies is
-- invisible to it. Continuous comparison of this invariant belongs in the
-- standing anonymous ACL invariant probe, not in a migration.
--
-- ON THE PRODUCTION CLUSTER this is expected to be a clean no-op: the single row
-- reported there for schema public and object type r is owned by postgres, which
-- the applying role is a member of, so the loop finds nothing and raises
-- nothing. That production shape is a measurement made by another seat on a
-- cluster the author of this file cannot read, and it is recorded as theirs
-- rather than restated as a first hand reading.
--
-- IDEMPOTENT AND SIDE EFFECT FREE. It reads catalogues and raises messages. It
-- can be applied any number of times, against any state, in any order relative
-- to every other migration in this tree.
--
-- REVERSAL: delete this file. It changes no privilege, so there is nothing to
-- put back.

do $$
declare
  v_tap    record;
  v_owned  bigint;
  v_kind   text;
  v_found  int := 0;
begin
  for v_tap in
    select pg_get_userbyid(d.defaclrole) as owner,
           d.defaclrole                  as owner_oid,
           d.defaclobjtype               as objtype,
           string_agg(a.privilege_type, ', ' order by a.privilege_type) as privs
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      join pg_roles r on r.oid = a.grantee
     where n.nspname = 'public'
       and r.rolname = 'anon'
       and not pg_has_role(current_user, pg_get_userbyid(d.defaclrole), 'MEMBER')
     group by 1, 2, 3
     order by 1, 3
  loop
    -- Count what the owning role actually holds in schema public, so the message
    -- can say LATENT or LIVE instead of leaving the reader to guess. The three
    -- object types are counted from different catalogues on purpose: sequences
    -- and tables both live in pg_class but under different relkind values, and
    -- functions are not in pg_class at all.
    if v_tap.objtype = 'r' then
      v_kind := 'table';
      select count(*) into v_owned
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relowner = v_tap.owner_oid
         and c.relkind in ('r', 'p');
    elsif v_tap.objtype = 'S' then
      v_kind := 'sequence';
      select count(*) into v_owned
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relowner = v_tap.owner_oid
         and c.relkind = 'S';
    elsif v_tap.objtype = 'f' then
      v_kind := 'function';
      select count(*) into v_owned
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proowner = v_tap.owner_oid;
    else
      -- A catalogue object type this check was not written for, for example 'T'
      -- for types or 'n' for schemas. Report the tap rather than dropping it,
      -- and say honestly that the liveness half is unknown. Silently skipping a
      -- row here would be the exact failure this file exists to end.
      v_kind := 'object of catalogue type ' || v_tap.objtype;
      v_owned := null;
    end if;

    v_found := v_found + 1;

    if v_owned is null then
      raise warning 'anon default privilege tap OPEN, liveness UNKNOWN: owning role % hands the anonymous role % on every new % it creates in schema public. This check does not know how to count objects of that catalogue type, so it cannot say whether the tap is producing anything today. No migration can close it: ALTER DEFAULT PRIVILEGES FOR ROLE % is permitted only to that role or a member of it, and the applying role % is not a member. Closing it is a platform request.',
        v_tap.owner, v_tap.privs, v_kind, v_tap.owner, current_user;
    elsif v_owned = 0 then
      raise warning 'anon default privilege tap OPEN and LATENT: owning role % hands the anonymous role % on every new % it creates in schema public. It owns 0 of them there today, so the tap produces nothing yet. No migration can close it: ALTER DEFAULT PRIVILEGES FOR ROLE % is permitted only to that role or a member of it, and the applying role % is not a member. Closing it is a platform request, and it becomes worth raising the moment this line reads LIVE.',
        v_tap.owner, v_tap.privs, v_kind, v_tap.owner, current_user;
    else
      raise warning 'anon default privilege tap OPEN and LIVE: owning role % hands the anonymous role % on every new % it creates in schema public, and it already owns % of them there. This is no longer latent, and row level security is the only thing still standing in front of those objects. No migration can close it: ALTER DEFAULT PRIVILEGES FOR ROLE % is permitted only to that role or a member of it, and the applying role % is not a member. Raise the platform request.',
        v_tap.owner, v_tap.privs, v_kind, v_owned, v_tap.owner, current_user;
    end if;
  end loop;

  if v_found = 0 then
    raise notice 'anon default privilege tap check: no default privilege in schema public grants the anonymous role anything through a tap the applying role (%) cannot narrow. Nothing to report.', current_user;
  else
    raise notice 'anon default privilege tap check: % tap(s) reported above. This file deliberately changes no privilege; it exists so the condition appears on the deploy log instead of being assumed away.', v_found;
  end if;
end $$;
