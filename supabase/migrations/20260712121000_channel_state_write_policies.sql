-- channel_state follow up: owner scoped write policies, and the seal_version rule.
--
-- Zero knowledge: this migration adds no column and reads no row. It only tightens
-- who may write. The server still cannot read a sealed row.
--
-- Idempotent: policies are DROP IF EXISTS then CREATE, and setting a comment
-- replaces it, so a re-run never doubles or wedges.
--
-- Reversible: the undo is at the foot of the file.

-- 1. Owner scoped write policies.
--
-- The only writer today is the edge function on the service role, which bypasses
-- RLS entirely, so these policies change nothing for the current write path. They
-- are the backstop for the day a path writes on a user JWT: without them such a
-- write is simply refused, rather than landing unchecked. with check pins the row
-- to the caller, so a client cannot claim another owner's user_id.
drop policy if exists "Owners can insert their channel state" on public.channel_state;
create policy "Owners can insert their channel state"
  on public.channel_state
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- using gates which rows may be updated, with check gates what they may become, so
-- an owner can neither reach another owner's row nor hand one away.
drop policy if exists "Owners can update their channel state" on public.channel_state;
create policy "Owners can update their channel state"
  on public.channel_state
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. seal_version: state the rule where the next writer is actually standing.
--
-- The default was already dropped by 20260712000000_channel_state_seal_version_no_default.sql,
-- so this file does not repeat that DDL. The reason for the missing default lived
-- only in that file and in a chat thread, and neither is visible from a psql session
-- or a table definition. Metadata only.
comment on column public.channel_state.seal_version is
  'No default by design: every insert must set this explicitly. The seal version is the only record of how to read the ciphertext, so an unstated version must fail closed rather than silently claim version 1.';

-- Undo:
--   comment on column public.channel_state.seal_version is null;
--   drop policy if exists "Owners can update their channel state" on public.channel_state;
--   drop policy if exists "Owners can insert their channel state" on public.channel_state;
