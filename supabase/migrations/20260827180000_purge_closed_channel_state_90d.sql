-- Closed Lightning channel state: retain 90 days, then delete automatically.
--
-- THE DECISION THIS IMPLEMENTS. 90 days. Founder ruling, 2026-08-25, recorded in the
-- delivery decision register. Compliance had asked for 30 and Product for 90; the number was
-- settled and this file is the half that makes it true rather than merely written down.
--
-- WHAT IS BEING DELETED. public.channel_state rows whose closed_at is not null and older than
-- the retention window. closed_at is stamped by the server (see the
-- channel_state_stamp_closed_at trigger) and is immutable once set, so it cannot be moved by a
-- client to keep or drop a row early. Rows with closed_at null are LIVE channels and are never
-- touched by this: an open channel has no retention clock running.
--
-- THE BOUNDARY IS DELIBERATE. The predicate is strictly less than, so a row closed exactly 90
-- days ago is KEPT and is removed on the next run. Retention of 90 days means 90 full days.
--
-- WHY THE FUNCTION COUNTS BEFORE IT DELETES. Row level security is enabled on channel_state and
-- there is no DELETE policy on it at all. This function is SECURITY DEFINER, so its owner
-- normally bypasses RLS and the delete works. But if FORCE ROW LEVEL SECURITY is ever turned on
-- for this table, the DELETE would match nothing, return zero, and this job would report a clean
-- run every night for as long as anyone cared to look. Counting what is due first and refusing
-- to return unless the two numbers agree is what makes that visible instead of silent.
--
-- WHY IT REFUSES TO INSTALL WITHOUT pg_cron. A deleter that is never called is worse than no
-- deleter, because it reads as done. If the extension is missing this migration fails at apply
-- time, loudly, rather than 90 days later.

create or replace function public.purge_closed_channel_state(p_retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_cutoff  timestamptz;
  v_due     integer;
  v_deleted integer;
begin
  -- A null or zero window would delete every closed channel on the spot. Refuse rather than
  -- interpret. This is customer data and there is no undo.
  if p_retention_days is null or p_retention_days < 1 then
    raise exception
      'purge_closed_channel_state: retention must be at least 1 day, got %', p_retention_days
      using errcode = 'P0001';
  end if;

  v_cutoff := now() - make_interval(days => p_retention_days);

  select count(*)
    into v_due
    from public.channel_state
   where closed_at is not null
     and closed_at < v_cutoff;

  delete from public.channel_state
   where closed_at is not null
     and closed_at < v_cutoff;

  get diagnostics v_deleted = row_count;

  -- Did it do the work, or did it merely finish? These two numbers are read from the same
  -- predicate in the same transaction, so they can only disagree if the DELETE could not see
  -- rows the SELECT could. That is a visibility fault, not an empty run, and it must never be
  -- reported as a successful purge.
  if v_deleted <> v_due then
    raise exception
      'purge_closed_channel_state: % row(s) were due for deletion but % were deleted. The '
      'delete could not see rows the select could, which usually means row level security is '
      'being enforced against the owner of this function. Nothing has been committed.',
      v_due, v_deleted
      using errcode = 'P0001';
  end if;

  return v_deleted;
end;
$fn$;

comment on function public.purge_closed_channel_state(integer) is
  'Deletes closed channel_state rows older than the retention window (default 90 days, the '
  'settled retention for closed Lightning channel data). Never touches a row whose closed_at is '
  'null, because that channel is still open. Returns the number of rows deleted, and raises if '
  'the number deleted does not match the number that were due.';

-- Named grantees, every one of them. A revoke that names only PUBLIC leaves the grant made to
-- anon exactly where it was, because Postgres stores them as separate access entries. This
-- function deletes customer data and nothing outside the scheduler has any business calling it.
revoke all on function public.purge_closed_channel_state(integer) from public, anon, authenticated;
grant execute on function public.purge_closed_channel_state(integer) to service_role;

-- The schedule. Without this the function above is a deleter nobody calls, which is exactly the
-- shape that reads as done and is not.
do $sched$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception
      'pg_cron is not installed, so the 90 day retention would never actually run. Install the '
      'extension and re-apply this migration rather than letting it succeed with no scheduler.'
      using errcode = 'P0001';
  end if;

  -- cron.schedule replaces a job of the same name, so re-applying this migration does not
  -- accumulate duplicate jobs.
  perform cron.schedule(
    'purge-closed-channel-state',
    '17 3 * * *',
    $cron$select public.purge_closed_channel_state(90)$cron$);
end;
$sched$;
