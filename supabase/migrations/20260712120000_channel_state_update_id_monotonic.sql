-- channel_state: the update_id watermark is enforced here, not in a policy.
--
-- RLS on this table is SELECT only, so there is no policy that can compare the
-- incoming row against the stored one. A BEFORE UPDATE trigger can, and it holds
-- for every writer including the service role, which bypasses RLS entirely.
--
-- The rule: an UPDATE that lowers update_id is refused. An UPDATE that keeps
-- update_id equal passes untouched, because a persist retried after a dropped ack
-- is an idempotent success, not an error. Only strictly lower is a fault.
--
-- Zero knowledge: this trigger reads update_id and nothing else. It never touches
-- sealed_ct, sealed_iv, or any key material.
--
-- Idempotent: CREATE OR REPLACE on both the function and the trigger.
-- Reversible: undo is at the foot of the file.

create or replace function public.channel_state_guard_update_id()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.update_id < old.update_id then
    raise exception
      'channel_state update_id is monotone: refused % because the stored row is already at %',
      new.update_id, old.update_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Named channel_state_guard_... on purpose. Postgres fires BEFORE triggers in name
-- order, and channel_state_stamp_closed_at already exists on this table. This guard
-- reads only update_id, so it is correct in either order, and sorting first keeps a
-- stale write from ever reaching the stamp.
create or replace trigger channel_state_guard_update_id
  before update on public.channel_state
  for each row
  execute function public.channel_state_guard_update_id();

-- Undo:
--   drop trigger if exists channel_state_guard_update_id on public.channel_state;
--   drop function if exists public.channel_state_guard_update_id();
