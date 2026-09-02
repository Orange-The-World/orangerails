-- Drop the dead platforms.quiltt_api_key_ciphertext column.
--
-- See the commit message for the full write-up: what was measured, why this is
-- worth a migration rather than leaving it, and why this file is numbered above
-- every other migration filename in the repo rather than relying on the apply
-- loop's version comparison.
--
-- This file is safe to apply to a cluster whose state has not been freshly
-- measured: the guard below runs BEFORE the drop and refuses if the column is
-- populated in any row, rather than assuming the counts measured on 2026-09-02
-- still hold.

do $$
declare
  v_populated int;
begin
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
