-- channel_state follow up: owner scoped write policies, and converge seal_version.
--
-- Zero knowledge: this migration adds no column and reads no row. It only tightens
-- who may write, and removes a default. The server still cannot read a sealed row.
--
-- Idempotent: policies are DROP IF EXISTS then CREATE, and DROP DEFAULT on a column
-- that already has no default is a no op, so a re-run never doubles or wedges.
--
-- Reversible: the undo is at the foot of the file, commented out.

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

-- 2. seal_version: converge the file and the live schema on not null, no default.
--
-- The create migration declares "default 1" but the live schema carries no default,
-- so a create generated from the repo would give a new environment a default the
-- existing one does not have. No default is also the safer shape: the seal version
-- is the only thing that says how to read the ciphertext, so the writer states it
-- rather than an unknown blob silently defaulting to v1. Metadata only, no rewrite.
alter table public.channel_state
  alter column seal_version drop default;

-- Undo:
--   alter table public.channel_state alter column seal_version set default 1;
--   drop policy if exists "Owners can update their channel state" on public.channel_state;
--   drop policy if exists "Owners can insert their channel state" on public.channel_state;
