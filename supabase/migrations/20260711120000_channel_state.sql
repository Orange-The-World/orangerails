-- channel_state: sealed LDK channel monitor state, owner scoped.
--
-- Zero knowledge: this table holds ciphertext and a blind index only. It never
-- holds a key, a seed, or plaintext channel data. The server cannot read a row.
--
-- Idempotent: every object is IF NOT EXISTS or CREATE OR REPLACE guarded, so a
-- re-run never doubles a row and never wedges the migration.
--
-- Reversible: this file only creates new objects. The undo is at the foot of the
-- file, commented out.

create table if not exists public.channel_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- HMAC-SHA-256 blind index of the channel outpoint, hex encoded by blindIndex().
  -- The regex is both the length check and the junk key guard.
  outpoint_bidx text not null
    constraint channel_state_outpoint_bidx_hex64
    check (outpoint_bidx ~ '^[0-9a-f]{64}$'),

  -- Sealed monitor blob. AES-GCM appends the auth tag to the ciphertext, so the
  -- floor is a 12 byte IV plus a 16 byte tag plus at least one byte of payload,
  -- decoded from the audited primitive's base64 on write.
  sealed_ct bytea not null
    constraint channel_state_sealed_ct_min_len
    check (length(sealed_ct) >= 17),

  -- Monotone watermark. The compare and set refuses a lower update_id and treats
  -- an equal update_id as idempotent success.
  update_id bigint not null
    constraint channel_state_update_id_non_negative
    check (update_id >= 0),

  -- Stamped server side by the trigger below, never trusted from the client.
  -- NULL means the channel is open and the row must never be purged.
  closed_at timestamptz null,

  created_at timestamptz not null default now()
);

-- The ON CONFLICT target for the compare and set on the update_id watermark.
create unique index if not exists channel_state_user_outpoint_uidx
  on public.channel_state (user_id, outpoint_bidx);

-- Retention scans only closed rows, so keep the index partial and small.
create index if not exists channel_state_closed_at_idx
  on public.channel_state (closed_at)
  where closed_at is not null;

-- closed_at is server time, set once, and never moved.
--
-- On insert or on the first close, any non-null closed_at the caller sends is
-- overwritten with now(). Once a row is closed, closed_at is frozen: it cannot be
-- moved earlier (which would purge the row ahead of its retention window) and it
-- cannot be set back to NULL (which would resurrect a closed channel).
create or replace function public.channel_state_stamp_closed_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.closed_at is not null then
      new.closed_at := now();
    end if;
    return new;
  end if;

  if old.closed_at is not null then
    new.closed_at := old.closed_at;
  elsif new.closed_at is not null then
    new.closed_at := now();
  end if;

  return new;
end;
$$;

create or replace trigger channel_state_stamp_closed_at
  before insert or update on public.channel_state
  for each row
  execute function public.channel_state_stamp_closed_at();

alter table public.channel_state enable row level security;

-- Owner scoped, mirroring the existing stealth tables: a signed in user reads only
-- their own rows, and there is no client write path at all. Writes arrive through
-- the edge function, which derives user_id from the JWT. A client sent owner id is
-- not a tenant boundary.
drop policy if exists "Owners can read their channel state" on public.channel_state;
create policy "Owners can read their channel state"
  on public.channel_state
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Undo:
--   drop trigger if exists channel_state_stamp_closed_at on public.channel_state;
--   drop function if exists public.channel_state_stamp_closed_at();
--   drop table if exists public.channel_state;
