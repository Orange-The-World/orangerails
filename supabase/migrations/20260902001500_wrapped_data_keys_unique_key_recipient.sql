-- Add UNIQUE (data_key_id, recipient_user_id) to public.wrapped_data_keys.
--
-- UNDO:
--   ALTER TABLE public.wrapped_data_keys
--     DROP CONSTRAINT wrapped_data_keys_key_recipient_uniq;
--
-- WHY. A recipient holds at most one wrapped copy of any given data key. Nothing
-- enforced that, so a repeated grant could leave two rows carrying the same
-- (data_key_id, recipient_user_id) and a reader that expects one row has no way
-- to tell which of them is current.
--
-- MEASURED BEFORE WRITING THIS, not assumed: public.wrapped_data_keys held 0
-- rows and 0 duplicate pairs on both the development and the production project,
-- so this constraint is added to an empty table and cannot fail on existing data.
--
-- WHY NOT CREATE UNIQUE INDEX CONCURRENTLY. The table is empty, so the exclusive
-- lock is held for microseconds and there is nothing to scan. CONCURRENTLY buys
-- nothing here and costs two real things: it cannot run inside a transaction
-- block, and a failed concurrent build leaves an INVALID index behind that a
-- later run has to notice and drop. A plain ADD CONSTRAINT is atomic and gives a
-- named constraint that ON CONFLICT can target.
--
-- DEVELOPMENT ONLY. Promotion to production is a separate two party write and is
-- deliberately not in this file.
--
-- Re-running this file is a no-op that still verifies. It never adds twice.

-- ---------------------------------------------------------------------------
-- 1. ADD IT, guarded on what the constraint IS and never on what it is called.
-- ---------------------------------------------------------------------------
--
-- A guard of the shape
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...')
-- turns a same-named constraint over DIFFERENT columns into a silent skip: the
-- migration does nothing, says nothing, and reports success while the wrong
-- constraint stays in place. Every branch below either changes something or
-- raises. None of them exits quietly.
DO $add$
DECLARE
  want_cols    smallint[];
  existing_def text;
  clash_name   text;
BEGIN
  SELECT array_agg(attnum ORDER BY attnum)
    INTO want_cols
    FROM pg_attribute
   WHERE attrelid = 'public.wrapped_data_keys'::regclass
     AND attname IN ('data_key_id', 'recipient_user_id')
     AND NOT attisdropped;

  IF want_cols IS NULL OR array_length(want_cols, 1) <> 2 THEN
    RAISE EXCEPTION
      'public.wrapped_data_keys does not carry both data_key_id and recipient_user_id; refusing to guess';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO existing_def
    FROM pg_constraint
   WHERE conrelid = 'public.wrapped_data_keys'::regclass
     AND conname  = 'wrapped_data_keys_key_recipient_uniq';

  IF existing_def IS NOT NULL THEN
    -- The name is taken. Whether that is fine depends entirely on the
    -- definition, which is the whole reason this guard reads it.
    IF existing_def <> 'UNIQUE (data_key_id, recipient_user_id)' THEN
      RAISE EXCEPTION
        'wrapped_data_keys_key_recipient_uniq already exists with a DIFFERENT definition: %. Resolve it deliberately; this migration will not skip past it.',
        existing_def;
    END IF;
    RAISE NOTICE
      'wrapped_data_keys_key_recipient_uniq is already present and correct; nothing to add';
  ELSE
    SELECT conname
      INTO clash_name
      FROM pg_constraint
     WHERE conrelid = 'public.wrapped_data_keys'::regclass
       AND contype  = 'u'
       AND (SELECT array_agg(k ORDER BY k) FROM unnest(conkey) AS k) = want_cols
     LIMIT 1;

    IF clash_name IS NOT NULL THEN
      -- Same columns, different name. Adding ours would build a second identical
      -- unique index. That is a decision for a person, not a migration.
      RAISE EXCEPTION
        'a unique constraint over (data_key_id, recipient_user_id) already exists as %; refusing to add a second',
        clash_name;
    END IF;

    ALTER TABLE public.wrapped_data_keys
      ADD CONSTRAINT wrapped_data_keys_key_recipient_uniq
      UNIQUE (data_key_id, recipient_user_id);

    RAISE NOTICE 'added wrapped_data_keys_key_recipient_uniq';
  END IF;
END
$add$;

-- ---------------------------------------------------------------------------
-- 2. VERIFY, by behaviour and not by reading the catalogue back at itself.
-- ---------------------------------------------------------------------------
--
-- The definition check is an exact string comparison and not a LIKE, so a
-- constraint over a superset of these columns cannot pass it.
--
-- The probe is the part that matters. pg_get_constraintdef proves the catalogue
-- holds the right words; it does not prove the constraint refuses anything. Both
-- columns are foreign keys (data_key_id to public.data_keys, recipient_user_id
-- to auth.users) and both parent tables are empty on the development cluster, so
-- the probe has to create its own parents rather than borrow a row.
--
-- NOTHING THE PROBE WRITES SURVIVES. The block that does the writing carries an
-- EXCEPTION clause, which makes it a subtransaction, and it always leaves by
-- raising. Whichever way the probe goes, the parents and the probe rows are
-- rolled back before the next statement runs. The boolean is a PL/pgSQL
-- variable, and those are not rolled back with the subtransaction, which is what
-- lets the result outlive the writes.
DO $verify$
DECLARE
  actual_def text;
  probe_user uuid := gen_random_uuid();
  probe_key  uuid := gen_random_uuid();
  refused    boolean := false;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO actual_def
    FROM pg_constraint
   WHERE conrelid = 'public.wrapped_data_keys'::regclass
     AND conname  = 'wrapped_data_keys_key_recipient_uniq'
     AND contype  = 'u';

  IF actual_def IS NULL THEN
    RAISE EXCEPTION
      'VERIFY FAILED: no unique constraint named wrapped_data_keys_key_recipient_uniq on public.wrapped_data_keys';
  END IF;

  IF actual_def <> 'UNIQUE (data_key_id, recipient_user_id)' THEN
    RAISE EXCEPTION
      'VERIFY FAILED: definition is [%], expected [UNIQUE (data_key_id, recipient_user_id)]',
      actual_def;
  END IF;

  BEGIN
    INSERT INTO auth.users (id) VALUES (probe_user);
    INSERT INTO public.data_keys (data_key_id, owner_user_id) VALUES (probe_key, probe_user);
    INSERT INTO public.wrapped_data_keys
      (data_key_id, recipient_user_id, wrapped_ciphertext, grant_sig)
      VALUES (probe_key, probe_user, 'probe-1', 'probe');

    BEGIN
      INSERT INTO public.wrapped_data_keys
        (data_key_id, recipient_user_id, wrapped_ciphertext, grant_sig)
        VALUES (probe_key, probe_user, 'probe-2', 'probe');
    EXCEPTION WHEN unique_violation THEN
      refused := true;
    END;

    -- Always leave by raising, so the probe's writes cannot outlive it.
    RAISE EXCEPTION USING ERRCODE = 'ORPRB', MESSAGE = 'probe finished';
  EXCEPTION WHEN SQLSTATE 'ORPRB' THEN
    NULL;
  END;

  IF NOT refused THEN
    RAISE EXCEPTION
      'VERIFY FAILED: a second row with the same (data_key_id, recipient_user_id) was ACCEPTED. The constraint is present in the catalogue and is not enforcing.';
  END IF;

  RAISE NOTICE
    'VERIFIED: wrapped_data_keys_key_recipient_uniq exists, reads exactly UNIQUE (data_key_id, recipient_user_id), and refused a live duplicate pair';
END
$verify$;
