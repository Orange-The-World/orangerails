-- REVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1518).
--
-- Every statement below has a restore path, so the classifier must return
-- REVERSIBLE with ZERO findings. If this file ever goes red, the classifier has
-- become too blunt to live with and the gate will be routed around instead of
-- used. Fix the classifier, do not weaken this fixture.
--
-- It carries, on purpose, the exact strings a naive grep would fire on:
-- DROP TABLE inside this comment, DROP TABLE inside a string literal, and
-- DROP TABLE inside a routine body that does not run at apply time.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create table if not exists public.or_fixture_widget (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  created_at timestamptz not null default now()
);

alter table public.or_fixture_widget add column if not exists note text;

alter table public.or_fixture_widget alter column note drop default;
alter table public.or_fixture_widget alter column note drop not null;

create index if not exists or_fixture_widget_label_idx
  on public.or_fixture_widget (label);

grant select on public.or_fixture_widget to authenticated;
revoke truncate, trigger on public.or_fixture_widget from authenticated;

insert into public.or_fixture_widget (label)
values ('drop table public.or_fixture_decoy');

delete from public.or_fixture_widget where label = 'obsolete';

drop policy if exists or_fixture_widget_read on public.or_fixture_widget;
create policy or_fixture_widget_read on public.or_fixture_widget
  for select to authenticated using (true);

create or replace function public.or_fixture_cleanup()
returns void
language plpgsql
as $$
begin
  -- This runs when somebody calls the function, not when this file is applied,
  -- so it is not an irreversible act of applying this migration.
  drop table if exists pg_temp.or_fixture_scratch;
end;
$$;
