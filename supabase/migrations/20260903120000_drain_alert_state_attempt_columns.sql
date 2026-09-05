-- OR-T1135: give the drain alarm a durable record of a failed notification
-- attempt, not only a successful one. Without these columns, a failed
-- Zulip post left nothing any query could find, so the alarm being dead
-- was indistinguishable from the alarm being fine. That silence went
-- unnoticed for ten days, twice.

alter table public.drain_alert_state
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text;

comment on column public.drain_alert_state.last_attempt_at is
  'Set on every notification attempt, success or failure. Distinct from last_notified_at, which is set only on success and is what the 60-minute cooldown reads.';
comment on column public.drain_alert_state.last_error is
  'Short reason the most recent attempt failed (missing env var name, or an HTTP status plus the first ~200 chars of the response body). Null after a successful attempt.';

do $$
declare
  v_missing text;
begin
  select string_agg(col, ', ')
    into v_missing
  from unnest(array['last_attempt_at', 'last_error']) as col
  where not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'drain_alert_state'
       and column_name = col
  );

  if v_missing is not null then
    raise exception 'drain_alert_state is missing expected column(s): %', v_missing;
  end if;
end $$;
