-- Requirement: public.apps.client_secret must not be selectable by the anon or
-- authenticated roles. Row-level security filters rows, not columns, so the
-- existing SELECT policy on public.apps cannot protect this column on its own.
-- Column-level privileges are the correct control.
--
-- Effect: anon and authenticated keep read access to the public metadata
-- columns only. Server-side roles are unaffected.
--
-- Reversible: yes. The undo is at the bottom of this file, commented out.
-- Idempotent: yes. GRANT and REVOKE converge to the same end state on re-run.
-- Locking: takes a brief ACCESS EXCLUSIVE lock on public.apps for the grant
-- change only. No table rewrite, no data movement.

begin;

revoke select on table public.apps from anon, authenticated;

grant select (
  id,
  slug,
  name,
  description,
  redirect_uri_pattern,
  created_at,
  updated_at
) on table public.apps to anon, authenticated;

commit;

-- Undo:
--   begin;
--   revoke select (id, slug, name, description, redirect_uri_pattern, created_at, updated_at)
--     on table public.apps from anon, authenticated;
--   grant select on table public.apps to anon, authenticated;
--   commit;
