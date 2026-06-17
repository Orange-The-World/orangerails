-- Beta gate for the data completeness dashboard (/data and /data/:pair).
-- Run this in the SQL editor of the PRIMARY Orange Rails project
-- (the project that VITE_ORANGERAILS_SUPABASE_URL points at), NOT orbi-prod.
--
-- This project owns user sessions (Supabase Auth email magic link) and the
-- allowlist below. orbi-prod is only the data source.

-- 1. Allowlist table -------------------------------------------------------
create table if not exists public.beta_approved_users (
  email       text primary key,
  approved    boolean not null default false,
  approved_at timestamptz,
  note        text
);

-- 2. Row level security ----------------------------------------------------
alter table public.beta_approved_users enable row level security;

-- A logged in user may read ONLY their own row, to check their own status.
-- Match on the JWT email claim. No insert/update/delete policies exist for
-- regular users, so only service_role (which bypasses RLS) can write.
drop policy if exists beta_self_read on public.beta_approved_users;
create policy beta_self_read
  on public.beta_approved_users
  for select
  to authenticated
  using (email = (auth.jwt() ->> 'email'));

-- (No anon access at all: anon cannot select this table.)

-- 3. Founder approves a user ----------------------------------------------
-- Run this one liner in the SQL editor (runs as service_role, bypasses RLS):
--
--   insert into public.beta_approved_users (email, approved, approved_at, note)
--   values ('person@example.com', true, now(), 'approved by founder')
--   on conflict (email) do update
--     set approved = true, approved_at = now();
--
-- To revoke access later:
--
--   update public.beta_approved_users
--     set approved = false where email = 'person@example.com';
--
-- To see who is waiting (every signed in user without approved = true):
--
--   select email, approved, approved_at, note from public.beta_approved_users
--     order by approved, email;
--
-- Note: a user only appears here after the founder inserts them. The pending
-- page is shown to any signed in user whose row is missing or approved = false.
-- If you want a request to auto record an unapproved row at sign in, add a
-- trigger on auth.users; for a small private beta, inserting on approval is
-- simpler and is what the SQL above assumes.

-- 4. Auth configuration (Supabase dashboard, one time) --------------------
--  - Authentication > Providers > Email: enable "Email" with magic link.
--  - Authentication > URL Configuration: add the site origin and
--    <origin>/auth/callback to the redirect allowlist
--    (for example https://orangetheworld.orangerails.com/auth/callback
--     plus the localhost dev origin).

-- 5. KNOWN GAP: pair_completeness is still anon readable on orbi-prod ------
-- The dashboard data lives in the orbi-prod project (sqcventmypowhbaceufy),
-- which is a SEPARATE Supabase project from this one. pair_completeness is
-- readable with the public orbi anon key via the policy
-- pair_completeness_public_read. The route guard added in this change stops
-- the UI from fetching until a user is signed in AND approved, but the data
-- is still technically reachable by anyone holding the public orbi anon key.
--
-- We did NOT flip orbi-prod RLS to require auth.role() = 'authenticated'
-- because the beta session is issued by THIS project, and its JWT will not
-- validate against orbi-prod (different jwt_secret). Requiring an
-- authenticated JWT on orbi-prod would break the anon read for approved
-- users too, with no working session to replace it.
--
-- Proper follow up (separate piece of work): route the dashboard reads
-- through an authenticated path that orbi-prod can verify. Options:
--   (a) an edge function on orbi-prod (or a gateway) that checks the
--       primary project session + beta_approved_users, then reads
--       pair_completeness with service_role and returns it; tighten
--       pair_completeness RLS to deny anon, OR
--   (b) federate the JWT so orbi-prod trusts the primary project signer.
-- Until then the gate is a UI gate, not a data gate.
