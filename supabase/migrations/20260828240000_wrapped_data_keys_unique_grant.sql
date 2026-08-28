-- DEV-0412: a retried co-admin grant creates a second wrapped_data_keys row
-- for the same (data_key_id, recipient_user_id), which the app loader's
-- maybeSingle() call cannot resolve, silently hiding the workspace from the
-- co-admin. Close the gap at the schema level so the duplicate insert fails
-- loudly instead.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wrapped_data_keys_data_key_id_recipient_user_id_key'
      and conrelid = 'public.wrapped_data_keys'::regclass
  ) then
    alter table public.wrapped_data_keys
      add constraint wrapped_data_keys_data_key_id_recipient_user_id_key
      unique (data_key_id, recipient_user_id);
  end if;
end $$;
