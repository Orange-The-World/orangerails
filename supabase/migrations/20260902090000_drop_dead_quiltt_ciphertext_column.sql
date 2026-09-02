-- Drop the dead platforms.quiltt_api_key_ciphertext column.
--
-- See the commit message for the full write-up: what was measured and why
-- this is worth a migration rather than leaving it. This file was numbered
-- above every migration filename in the repo at the time it was written;
-- a later file (20260903020000, PR #1123) now sits above it, which is fine
-- because both files are guarded on the column's existence rather than on
-- apply order, so neither depends on which one lands first.
--
-- This file assumes the migration apply loop wraps each file in a single
-- transaction, so Guard A, the DROP, and Guard B execute as one atomic
-- unit. If that ever stops being true, this file needs an explicit
-- begin/commit; do not assume it silently still holds.
--
-- This file is safe to apply to a cluster whose state has not been freshly
-- measured: the guard below runs BEFORE the drop and refuses if the column is
-- populated in any row, rather than assuming the counts measured on 2026-09-02
-- still hold.

do $$
declare
  v_populated int;
begin
  -- Take the same ACCESS EXCLUSIVE lock the DROP will take, but take it here,
  -- first, so the row count below and the DROP describe the same instant.
  -- Without this, a write could land between the count and the DROP taking
  -- its own lock: invisible to the guard, then destroyed by the DROP. This
  -- adds no extra lock duration overall, it only moves the lock earlier.
  lock table public.platforms in access exclusive mode;

  -- Guard A, before the drop. Refuse to run at all if the column is doing
  -- anything on this cluster. A migration that silently drops live data on a
  -- cluster nobody re-measured is worse than a migration that fails loud.
  select count(*)
    into v_populated
    from public.platforms
   where quiltt_api_key_ciphertext is not null;

  if v_populated <> 0 then
    raise exception 'drop_dead_quiltt_ciphertext_column FAILED: platforms.quiltt_api_key_ciphertext is populated in % row(s) on this cluster; refusing to drop a column that appears to be in use. Re-derive whether this file still applies before proceeding.', v_populated;
  end if;

  raise notice 'drop_dead_quiltt_ciphertext_column: confirmed 0 populated rows, proceeding with the drop.';
end $$;

alter table public.platforms
  drop column if exists quiltt_api_key_ciphertext;

-- Guard B, after the drop. Assert the END STATE: the column must actually be
-- gone. Catches a rebuilt or reseeded environment that re-adds it, and a later
-- migration that undoes this one, on the next apply of this file.
do $$
begin
  if exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'platforms'
          and column_name = 'quiltt_api_key_ciphertext'
     ) then
    raise exception 'drop_dead_quiltt_ciphertext_column FAILED: platforms.quiltt_api_key_ciphertext still exists after the drop statement.';
  end if;

  raise notice 'drop_dead_quiltt_ciphertext_column: end state verified, column is gone.';
end $$;
