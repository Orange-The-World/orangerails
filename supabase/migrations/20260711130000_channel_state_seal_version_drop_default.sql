-- channel_state.seal_version: drop the column default.
--
-- The table was created with `seal_version smallint not null default 1`. The
-- agreed shape is NOT NULL with NO default, and this file closes that gap.
--
-- Why: the seal primitive does not persist its algorithm name, so seal_version is
-- the only thing that says how to read a row. With a default, a writer that omits
-- the column silently records the row as version 1. If the seal format ever moves
-- to version 2, those bytes are stamped with the wrong version and the row can
-- never be decrypted again. Without the default the insert fails at write time,
-- which is the outcome we want: fail loudly, never store an unreadable row.
--
-- After this, every writer sets seal_version explicitly.
--
-- Idempotent: DROP DEFAULT on a column that has no default is a no op, so a re-run
-- never wedges the migration.
-- Reversible: the undo is at the foot of the file.

alter table public.channel_state
  alter column seal_version drop default;

-- Undo:
--   alter table public.channel_state alter column seal_version set default 1;
