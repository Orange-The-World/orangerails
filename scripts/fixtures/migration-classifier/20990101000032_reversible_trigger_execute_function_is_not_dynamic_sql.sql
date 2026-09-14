-- REVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1518).
--
-- CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION name() is the ordinary,
-- everyday way to attach a trigger. The routine identifier is written out
-- in the file; nothing is assembled at run time. Before OR-T1518,
-- executeIsUnreadable matched the bare word EXECUTE with no exemption for
-- this clause, so this file classified IRREVERSIBLE as DYNAMIC EXECUTE even
-- though the attached function only touches a timestamp column. Fixtures
-- 24, 28 and 29 already cover a trigger whose function genuinely empties a
-- table; this one proves the harmless case is not punished the same way.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create table if not exists public.or_fixture_touch_audit (
  id bigserial primary key,
  note text,
  updated_at timestamptz not null default now()
);

create or replace function public.or_fixture_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger or_fixture_touch_updated_at_before_update
  before update on public.or_fixture_touch_audit
  for each row execute function public.or_fixture_touch_updated_at();
