-- ---------------------------------------------------------------------------
-- One wrapped key per (data_key_id, recipient_user_id).
--
-- WHAT THIS ADDS
--   ALTER TABLE public.wrapped_data_keys
--     ADD CONSTRAINT wrapped_data_keys_key_recipient_uniq
--     UNIQUE (data_key_id, recipient_user_id);
--
-- UNDO
--   ALTER TABLE public.wrapped_data_keys
--     DROP CONSTRAINT wrapped_data_keys_key_recipient_uniq;
--
-- WHY NOT CONCURRENTLY. Both clusters hold zero rows in this table, so the
-- exclusive lock is held for microseconds and there is nothing to scan. A
-- concurrent build buys nothing here and costs two real things: it cannot run
-- inside a transaction block, and a failed concurrent build leaves an INVALID
-- index behind that some later run has to notice and drop. A plain named
-- constraint is atomic and gives ON CONFLICT a name to target.
--
-- WHY THE GUARD DOES NOT LOOK AT THE NAME ALONE. A guard that only asks
-- whether a constraint of this name exists will find a constraint of this name
-- over DIFFERENT columns, do nothing, and report success, leaving the rule this
-- migration exists to create absent while every signal says it landed. So the
-- guard compares the DEFINITION. A same-named constraint with a different
-- definition stops this migration loudly.
--
-- WHY IT INSERTS A DUPLICATE. Reading pg_get_constraintdef back proves the
-- catalogue says the right words. It does not prove the database refuses
-- anything. The block at the bottom inserts a real second row for the same pair
-- and requires the database to reject it, then removes its own fixture and
-- checks the row count is back where it started.
--
-- IT IS KNOWN TO BE ABLE TO FAIL. The verification block was run on its own
-- against the current unguarded dev state before this file was committed, and
-- raised:
--   ERROR: P0001: VERIFICATION FAILED: public.wrapped_data_keys accepted a
--   SECOND row with the same (data_key_id, recipient_user_id). The uniqueness
--   this migration exists to create is not being enforced.
-- A check nobody has watched go red is not known to work.
--
-- SCOPE: dev. Production is a separate two-party write and is deliberately not
-- in this file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Add the constraint, guarded on what it MEANS rather than what it is called.
-- ---------------------------------------------------------------------------
DO $add_constraint$
DECLARE
  c_name  constant text := 'wrapped_data_keys_key_recipient_uniq';
  c_def   constant text := 'UNIQUE (data_key_id, recipient_user_id)';
  v_found_def     text;
  v_covering_index text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO v_found_def
    FROM pg_constraint
   WHERE conrelid = 'public.wrapped_data_keys'::regclass
     AND conname  = c_name;

  IF v_found_def IS NOT NULL THEN
    IF v_found_def = c_def THEN
      RAISE NOTICE 'Already present: % is %. Nothing to add.', c_name, c_def;
    ELSE
      -- The dangerous case, and the reason this guard is not a name check.
      RAISE EXCEPTION
        'Refusing to continue: a constraint named % already exists on public.wrapped_data_keys with a DIFFERENT definition. Found: %. Expected: %. Adopting it silently would leave this table without the uniqueness rule while every signal says the migration succeeded.',
        c_name, v_found_def, c_def;
    END IF;
  ELSE
    -- The name is free. The pair may still already be unique under another
    -- name, from a constraint or from a bare unique index. Adding a second
    -- index over the same columns would be pure duplicated write cost, so
    -- check the columns rather than the names.
    SELECT i.indexrelid::regclass::text
      INTO v_covering_index
      FROM pg_index i
     WHERE i.indrelid = 'public.wrapped_data_keys'::regclass
       AND i.indisunique
       AND i.indnatts = 2
       AND i.indnkeyatts = 2
       AND (
             SELECT array_agg(a.attname::text ORDER BY a.attname)
               FROM pg_attribute a
              WHERE a.attrelid = i.indrelid
                AND a.attnum = ANY (string_to_array(i.indkey::text, ' ')::smallint[])
           ) = ARRAY['data_key_id', 'recipient_user_id']
     LIMIT 1;

    IF v_covering_index IS NOT NULL THEN
      RAISE NOTICE
        'The pair (data_key_id, recipient_user_id) is already unique under %. Not adding a second index over the same columns. The verification below still runs and still has to pass.',
        v_covering_index;
    ELSE
      EXECUTE format(
        'ALTER TABLE public.wrapped_data_keys ADD CONSTRAINT %I UNIQUE (data_key_id, recipient_user_id)',
        c_name
      );
      RAISE NOTICE 'Added % as %.', c_name, c_def;
    END IF;
  END IF;
END
$add_constraint$;

-- ---------------------------------------------------------------------------
-- 2. Verify the BEHAVIOUR, not the catalogue text.
--
-- Both foreign keys on this table have to be satisfied for the probe rows to
-- exist at all, so it creates its own throwaway user and workspace key, uses
-- random ids that cannot collide with real data, removes everything it made,
-- and then checks the row count is unchanged. Any failure raises, and a raise
-- aborts the whole migration, so a half-run probe cannot leave rows behind.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_user  uuid := gen_random_uuid();
  v_key   uuid := gen_random_uuid();
  v_rows_before bigint;
  v_rows_after  bigint;
  v_duplicate_was_accepted boolean := false;
BEGIN
  SELECT count(*) INTO v_rows_before FROM public.wrapped_data_keys;

  INSERT INTO auth.users (id) VALUES (v_user);
  INSERT INTO public.data_keys (data_key_id, owner_user_id) VALUES (v_key, v_user);

  INSERT INTO public.wrapped_data_keys
    (data_key_id, recipient_user_id, wrapped_ciphertext, grant_sig)
  VALUES (v_key, v_user, 'constraint-probe-row-1', 'constraint-probe-sig');

  BEGIN
    INSERT INTO public.wrapped_data_keys
      (data_key_id, recipient_user_id, wrapped_ciphertext, grant_sig)
    VALUES (v_key, v_user, 'constraint-probe-row-2', 'constraint-probe-sig');
    v_duplicate_was_accepted := true;
  EXCEPTION WHEN unique_violation THEN
    -- The one error this block is allowed to swallow, and only here. Anything
    -- else, including a foreign key or a privilege failure, must reach the top
    -- and stop the migration: a probe that cannot run must never read as a
    -- probe that passed.
    v_duplicate_was_accepted := false;
  END;

  DELETE FROM public.wrapped_data_keys WHERE data_key_id = v_key;
  DELETE FROM public.data_keys WHERE data_key_id = v_key;
  DELETE FROM auth.users WHERE id = v_user;

  IF v_duplicate_was_accepted THEN
    RAISE EXCEPTION
      'VERIFICATION FAILED: public.wrapped_data_keys accepted a SECOND row with the same (data_key_id, recipient_user_id). The uniqueness this migration exists to create is not being enforced.';
  END IF;

  SELECT count(*) INTO v_rows_after FROM public.wrapped_data_keys;
  IF v_rows_after <> v_rows_before THEN
    RAISE EXCEPTION
      'VERIFICATION FAILED: the probe left rows behind (% before, % after).',
      v_rows_before, v_rows_after;
  END IF;

  RAISE NOTICE
    'VERIFIED: a duplicate (data_key_id, recipient_user_id) was refused, and the probe left no rows behind.';
END
$verify$;
