-- 20260828234000_wrapped_data_keys_complete_grant_rule.sql
--
-- Refuse an envelope v3 grant that carries no keyring for the recipient to
-- open. Decided on DEV-0384, raised by the reviewer of the migration that added
-- the v3 grant columns (20260828183000).
--
-- WHAT WAS WRONG. 20260828183000 added
-- wrapped_data_keys_carries_key_material, num_nonnulls(wrapped_ciphertext,
-- wrapped_cak) >= 1. That was the right rule to add at the time: it is the
-- weakest thing that refuses a row holding nothing at all, and it replaced the
-- NOT NULL that the same migration dropped. It has one gap. A row with
-- wrapped_cak set and coadmin_keyring_ciphertext null passes it, and that row
-- is a v3 grant carrying the wrapped co-admin key and no sealed keyring, so
-- there is nothing for the recipient to open. That is not a classification
-- nicety: 20260828183000 states, in the column comment it writes, that a reader
-- decides which envelope a row is by which of these columns is actually
-- present, never by trusting the algorithm string. So a reader must call that
-- row v3 and then fail on it.
--
-- WHAT THIS SUBSTITUTES. wrapped_data_keys_carries_a_complete_grant:
--
--   wrapped_ciphertext IS NOT NULL
--   OR (wrapped_cak IS NOT NULL AND coadmin_keyring_ciphertext IS NOT NULL)
--
-- Still a pure null presence rule. It names no algorithm string, pins no
-- length, and inspects no ciphertext, so it does not recreate the
-- extensibility trap 20260828183000 was avoiding. A v2 row passes. A complete
-- v3 row passes. A row carrying BOTH shapes passes, so writing one grant that a
-- v2 reader and a v3 reader can each consume stays legal and the transition
-- option stays open. A wrapped_cak with no keyring is refused, a keyring with
-- no wrapped_cak is refused, and an empty grant is refused.
--
-- THE ARGUMENT AGAINST IT, AND WHY IT LOSES. The tighter rule does pin v3's two
-- column shape into the schema: an envelope that later pairs wrapped_cak with
-- some other column would have to change it. That envelope needs a new column,
-- so it needs a migration anyway, and extending this rule there is one more
-- ALTER in a file that has to exist regardless. Against that one time cost sits
-- a permanent one: an unopenable grant row that reads as live. Both projects
-- hold 0 rows in this table, measured read only on 2026-08-28 before writing
-- this, so the tighter rule validates immediately and costs nothing today. It
-- stops being free the moment grants exist.
--
-- WHY A NEW NAME RATHER THAN A DROP AND RECREATE UNDER THE OLD ONE. Two
-- different definitions must never share one constraint name in this table's
-- history, because 20260828183000 identifies its constraint by name in two of
-- its own assertions. A new name keeps one name to one definition, and makes
-- the substitution visible to anyone reading the schema instead of silent.
--
-- WHY THE ADD IS NOT GUARDED BY NAME. 20260828183000 added its constraint only
-- if one of that name did not already exist, and then asserted on the name. A
-- constraint that already carried that name with some other definition would
-- have survived both. Here the drop is unconditional and so is the add, so the
-- definition in the database is this one by construction rather than by hope,
-- and assertion 4 below checks the DEFINITION, not the name.
--
-- ORDER. This migration reads coadmin_keyring_ciphertext, so 20260828183000
-- must have applied first. Assertion 0 says so in one line rather than letting
-- the failure arrive as a bare undefined column.
--
-- HOW THE ASSERTIONS BELOW DECIDE WHAT A PRESENCE RULE MAY CONTAIN. By
-- allowlist, not by denylist. Decided on DEV-0400, raised by the reviewer of
-- this file. The first version of the assertion listed what a definition may
-- NOT contain: length, substring, position, starts_with, encode, decode,
-- similar, left, right, and the tilde the regex operators render as. A
-- denylist over SQL text leaks, and five forms walked through that one.
-- wrapped_cak <> '' is the sharpest, because it is exactly equivalent to
-- length(wrapped_cak) > 0, which WAS caught: the forbidden thing and the
-- permitted thing were the same rule written two ways. The others were strpos
-- and split_part, md5 and any other hash, regexp_like in function form, and
-- the ^@ starts-with operator.
--
-- So the test is inverted. A presence rule may contain the column names of
-- this table and the words IS, NOT, NULL, AND, OR, plus parentheses and
-- whitespace, and nothing else. Strip all of that from the definition and what
-- remains must be empty. Anything that is not a pure presence test fails by
-- default rather than by having been thought of.
--
-- TWO CONSEQUENCES OF THE ALLOWLIST, both deliberate. First, num_nonnulls(a,
-- b) >= 1 is now refused even though it is genuinely contents blind, because
-- admitting it means admitting a function call, a comparison operator and an
-- integer literal, which is exactly the door wrapped_cak <> '' walks through.
-- A future presence rule that truly needs that form widens this assertion in
-- its own migration and says why. Second, a column whose name is not a plain
-- lowercase identifier is left out of the allowlist, so a constraint
-- referencing one fails here. Failing closed on an unusual name is the right
-- default for a rule guarding key material.
--
-- WHAT THE SCOPING DELIBERATELY LEAVES OUT, stated here rather than left
-- implicit. The property test examines only check constraints that reference
-- coadmin_keyring_ciphertext or wrapped_cak.
-- wrapped_data_keys_grant_sig_nonempty, CHECK (length(grant_sig) > 0), is
-- therefore out of scope and survives. That is correct rather than an
-- oversight: grant_sig is a signature over a grant, not opaque key material,
-- and its length reveals nothing about a key. Measured while writing this: run
-- through the allowlist it WOULD be refused, so the scoping is load bearing.
--
-- ONE ORDERING CAVEAT, recorded rather than fixed. Once this migration has
-- applied, 20260828183000 is no longer safely re-runnable ON ITS OWN: its own
-- assertion excludes wrapped_data_keys_carries_key_material BY NAME, so with
-- wrapped_data_keys_carries_a_complete_grant present it would raise. In order
-- apply is fine and a clean replay from an empty database is fine, because
-- that file always runs first. Only an out of order or repair re-run of it
-- alone is affected. Nothing in this file can fix that, because a DO block
-- runs once, in timestamp order, and cannot police a migration that runs after
-- it. The standing check on the merge path (DEV-0395) is where that belongs.
--
-- TO UNDO. Drop wrapped_data_keys_carries_a_complete_grant and add
-- wrapped_data_keys_carries_key_material back with its original definition,
-- CHECK (num_nonnulls(wrapped_ciphertext, wrapped_cak) >= 1). Nothing here
-- deletes a row or changes one, so an undo loses no data. Every row that
-- satisfies the new rule satisfies the old one, so the undo validates on any
-- data this rule allowed in.
--
-- Idempotent: both names are dropped IF EXISTS before the add, so a re-run
-- rebuilds exactly this definition rather than failing on the constraint it
-- created itself.
--
-- PROVEN BEFORE WRITING, on the development project, inside a transaction that
-- was deliberately aborted so nothing persisted. Against the OLD rule, a row
-- with wrapped_cak set and no keyring was ACCEPTED. Against this rule the same
-- insert was refused with 23514, a keyring with no wrapped_cak was refused with
-- 23514, an empty grant was refused with 23514, and a v2 row, a complete v3 row
-- and a row carrying both shapes were all accepted. The table, both parent
-- tables and the schema were re-read afterwards and were unchanged.
--
-- THE ALLOWLIST ITSELF WAS PROVEN THE SAME WAY, read only on the development
-- project: the exact stripping expression used below was run over eleven
-- candidate definitions. The rule this migration adds strips to the empty
-- string and is accepted. All five forms that leaked through the old denylist
-- leave a residue and are refused: <> ''::text, strpos, split_part, md5,
-- regexp_like and ^@. length and the regex operator, which the old denylist
-- did catch, are still refused. num_nonnulls and the grant_sig length rule are
-- refused too, which is why both are written up above.

DO $do$
BEGIN
  -- 0. Precondition: the v3 grant columns are here, so 20260828183000 has run.
  IF (SELECT count(*)
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'wrapped_data_keys'
         AND column_name IN ('coadmin_keyring_ciphertext', 'wrapped_cak')) <> 2 THEN
    RAISE EXCEPTION
      'the v3 grant columns are missing, apply 20260828183000 before this migration';
  END IF;
END;
$do$;

ALTER TABLE public.wrapped_data_keys
  DROP CONSTRAINT IF EXISTS wrapped_data_keys_carries_key_material;

ALTER TABLE public.wrapped_data_keys
  DROP CONSTRAINT IF EXISTS wrapped_data_keys_carries_a_complete_grant;

ALTER TABLE public.wrapped_data_keys
  ADD CONSTRAINT wrapped_data_keys_carries_a_complete_grant
  CHECK (wrapped_ciphertext IS NOT NULL
         OR (wrapped_cak IS NOT NULL AND coadmin_keyring_ciphertext IS NOT NULL));

COMMENT ON CONSTRAINT wrapped_data_keys_carries_a_complete_grant ON public.wrapped_data_keys IS
  'A grant row must carry enough key material for its recipient to open it: a v2 blob in wrapped_ciphertext, or a v3 pair of wrapped_cak AND coadmin_keyring_ciphertext, or both. Pure null presence: it never reads what is inside a ciphertext column and nothing may be added here that does.';

-- Prove it, rather than assume the statements above did what they say. The
-- checks below read the constraint DEFINITION, not its name, because a name
-- proves nothing about what a constraint actually enforces. They test a
-- PROPERTY of the definition (it contains nothing but a null presence test)
-- rather than comparing it to a fixed string, because pinning the exact text
-- would make this file fail on a replay after any later legitimate change to
-- the same presence rule. The property is decided by an ALLOWLIST of what a
-- presence rule may contain, never by a denylist of what it may not.
DO $do$
DECLARE
  opaque_cols text[] := ARRAY['coadmin_keyring_ciphertext', 'wrapped_cak'];
  -- Everything a pure null presence rule is allowed to contain, beyond the
  -- column names of this table, the parentheses and the whitespace.
  presence_words text[] := ARRAY['check', 'is', 'not', 'null', 'and', 'or'];
  allowed text;
  thedef text;
  residue text;
  offenders text;
  r record;
BEGIN
  -- Build the allowlist from the LIVE column list, so it never has to be kept
  -- in step with the table by hand. A column whose name is not a plain
  -- lowercase identifier is deliberately left out, so a constraint that
  -- references one fails this test rather than silently widening it.
  SELECT string_agg(w, '|' ORDER BY length(w) DESC, w) INTO allowed
  FROM (
    SELECT attname AS w
      FROM pg_attribute
     WHERE attrelid = 'public.wrapped_data_keys'::regclass
       AND attnum > 0
       AND NOT attisdropped
       AND attname ~ '^[a-z_][a-z0-9_]*$'
    UNION ALL
    SELECT unnest(presence_words)
  ) words;

  -- 1. The superseded constraint is gone, so the table carries one presence
  --    rule and not two.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.wrapped_data_keys'::regclass
       AND conname = 'wrapped_data_keys_carries_key_material'
  ) THEN
    RAISE EXCEPTION
      'wrapped_data_keys_carries_key_material is still present, the drop did nothing';
  END IF;

  -- 2. The new rule is there and is validated, so the invariant has a live
  --    replacement rather than a statement that quietly did nothing.
  SELECT pg_get_constraintdef(oid) INTO thedef
  FROM pg_constraint
  WHERE conrelid = 'public.wrapped_data_keys'::regclass
    AND conname = 'wrapped_data_keys_carries_a_complete_grant'
    AND contype = 'c'
    AND convalidated;
  IF thedef IS NULL THEN
    RAISE EXCEPTION
      'wrapped_data_keys_carries_a_complete_grant is missing or not validated, an incomplete grant row would be accepted';
  END IF;

  -- 3. It really does name all three columns and really does require the v3
  --    pair together, so the tightening happened rather than a weaker rule
  --    landing under the new name.
  IF thedef NOT LIKE '%coadmin_keyring_ciphertext%'
     OR thedef NOT LIKE '%wrapped_cak%'
     OR thedef NOT LIKE '%wrapped_ciphertext%' THEN
    RAISE EXCEPTION
      'the presence rule does not read all three key material columns: %', thedef;
  END IF;

  -- 4. It is a null presence rule and NOTHING else. Strip the words such a rule
  --    is allowed to contain, then the parentheses and the whitespace: what is
  --    left must be empty. A function call, a comparison operator or a literal
  --    all survive the stripping and fail here, which is what the allowlist
  --    buys over the denylist it replaced. This is also the check that
  --    20260828183000 could not make, because it excluded its own constraint by
  --    NAME: a rule carrying a length or shape test on opaque ciphertext would
  --    have passed there under the right name, and fails here.
  residue := regexp_replace(
               regexp_replace(thedef, '\m(' || allowed || ')\M', ' ', 'gi'),
               '[()[:space:]]', '', 'g');
  IF residue <> '' THEN
    RAISE EXCEPTION
      'the presence rule is not a pure null presence test, it also contains "%": %',
      residue, thedef;
  END IF;

  -- 5. No OTHER check constraint on this table does anything but test presence
  --    on the opaque grant columns. Same allowlist, applied to every check
  --    constraint that references one of them, so a future one cannot hide
  --    behind a name this file happens to know. Scoped on purpose:
  --    wrapped_data_keys_grant_sig_nonempty references none of these columns
  --    and is out of scope, because grant_sig is a signature rather than opaque
  --    key material and its length reveals nothing about a key.
  offenders := NULL;
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.wrapped_data_keys'::regclass
       AND contype = 'c'
       AND EXISTS (
         SELECT 1 FROM unnest(opaque_cols) AS c
          WHERE pg_get_constraintdef(oid) LIKE '%' || c || '%'
       )
     ORDER BY conname
  LOOP
    residue := regexp_replace(
                 regexp_replace(r.def, '\m(' || allowed || ')\M', ' ', 'gi'),
                 '[()[:space:]]', '', 'g');
    IF residue <> '' THEN
      offenders := concat_ws(', ', offenders, r.conname || ' (' || residue || ')');
    END IF;
  END LOOP;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'a check constraint on the opaque grant columns is not a pure null presence test: %', offenders;
  END IF;

  -- 6. No check constraint ties row shape to the algorithm string, in either
  --    direction. A v3 recipient must still be able to consume a v2 grant.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO offenders
  FROM pg_constraint
  WHERE conrelid = 'public.wrapped_data_keys'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%algorithm%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'a check constraint now ties row shape to the algorithm string: %', offenders;
  END IF;

  -- 7. wrapped_ciphertext is still nullable, so a v3 grant row can still exist
  --    without inventing a value for a v2 only column.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'wrapped_data_keys'
       AND column_name = 'wrapped_ciphertext'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'wrapped_ciphertext is NOT NULL again, a v3 grant row cannot be written';
  END IF;
END;
$do$;
