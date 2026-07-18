-- channel_state.seal_version: drop the default so a missing version fails loud.
--
-- With `default 1`, a writer that omits seal_version silently stamps a v2
-- envelope as v1. The row is then decoded under the wrong version forever, with
-- no error at write time. NOT NULL with no default turns that bug into an
-- immediate insert error, which is the property we want on funds adjacent
-- ciphertext.
--
-- Forward only on purpose: 20260711120000_channel_state.sql is already applied
-- on dev, so editing it in place would risk a migration history checksum
-- mismatch.
--
-- Idempotent: dropping a default is a no-op when there is no default.
-- Reversible (undo):
--   alter table public.channel_state alter column seal_version set default 1;

alter table public.channel_state
  alter column seal_version drop default;
