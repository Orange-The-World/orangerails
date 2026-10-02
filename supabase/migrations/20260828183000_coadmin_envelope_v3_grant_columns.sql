-- 20260828183000_coadmin_envelope_v3_grant_columns.sql
--
-- Envelope v3, co-admin half: somewhere to put the per grant sealed keyring
-- and the wrapped co-admin key.
--
-- WHAT THIS ADDS. Two nullable text columns on public.wrapped_data_keys, both
-- additive, no backfill.
--
--   coadmin_keyring_ciphertext
--     Base64 of IV(12) || AES-256-GCM ciphertext || tag(16). The plaintext is
--     canonical JSON carrying its own version field and holding a projection
--     of the owner keyring: the data key arrays and nothing else. Opaque
--     ciphertext, so no index, no constraint on contents, no length
--     constraint.
--
--   wrapped_cak
--     Base64 of the hybrid KEM wrapped co-admin key. Same treatment: opaque,
--     no index, no length constraint.
--
-- WHY NO LENGTH CONSTRAINT ANYWHERE. Pinning a ciphertext length is what made
-- the previous co-admin construction impossible to extend: the wire format was
-- hard checked at 64 bytes in one place, split at byte 32 in another, and
-- named in a third. A constraint here would add a fourth place to change.
--
-- WHY BOTH COLUMNS GO ON wrapped_data_keys AND NOT ON A NEW TABLE. Revoking a
-- grant deletes the wrapped_data_keys row for (data_key_id,
-- recipient_user_id). Keeping all the key material for one grant on that one
-- row keeps revocation a single delete that cannot half succeed and leave live
-- key material addressed to a revoked admin.
--
-- VERSIONS COEXIST BY DESIGN, AND THAT IS WHY wrapped_ciphertext LOSES ITS NOT
-- NULL. A v2 row fills wrapped_ciphertext and leaves the two new columns null.
-- A v3 row fills the two new columns and has no 64 byte subkey blob to put in
-- wrapped_ciphertext at all. A vault version never decides whether a grant is
-- valid, so both shapes must be insertable and readable at the same time.
-- Keeping NOT NULL would force a v3 writer to invent a sentinel value in a
-- column that exists to carry key material, and under v3 the grant signature
-- covers the wrapped co-admin key rather than this column, so that sentinel
-- would also be unsigned. Measured on 2026-08-28 before writing this:
-- public.wrapped_data_keys holds 0 rows on both the development and the
-- production project, so dropping the NOT NULL is reversible today at no cost.
-- The read path still fails closed on a missing or unverifiable grant: it
-- refuses to decrypt unless the grant signature is present and verifies.
--
-- WHAT REPLACES THE INVARIANT NOT NULL WAS CARRYING. NOT NULL was, by
-- accident, the only thing stopping a grant row that carries no key material
-- at all. Dropping it without a replacement would let an empty grant be
-- inserted and read back as if it were real. So this migration adds
-- wrapped_data_keys_carries_key_material, num_nonnulls(wrapped_ciphertext,
-- wrapped_cak) >= 1. It names no algorithm string, permits a v2 row, permits a
-- v3 row, and permits both to exist side by side. It is the weakest rule that
-- still refuses a row with nothing in it. The table is empty on both projects,
-- so it validates immediately and at no cost.
--
-- NO CHECK CONSTRAINT FORCING ONE SHAPE OR THE OTHER. A recipient on v3 has to
-- be able to consume a v2 grant from an owner still on v2, and the reverse.
-- Tying the filled columns to the algorithm string would pin the schema to a
-- fixed set of algorithm strings and break that, which is what assertion 4
-- below exists to refuse.
--
-- NO NEW GRANT AND NO NEW POLICY. The existing SELECT policy scopes rows to
-- recipient_user_id = auth.uid(), and new columns inherit the table privileges
-- the existing ciphertext column already carries. The assertions below prove
-- the two new columns are no wider than wrapped_ciphertext rather than
-- assuming it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP NOT NULL is a no-op the second
-- time, and the constraint is added only if it is not already there. The
-- assertions fail loudly rather than letting a partial apply look like a
-- success.

ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS coadmin_keyring_ciphertext text,
  ADD COLUMN IF NOT EXISTS wrapped_cak text;

COMMENT ON COLUMN public.wrapped_data_keys.coadmin_keyring_ciphertext IS
  'Envelope v3 co-admin grant. Base64 IV(12) || AES-256-GCM ciphertext || tag(16) of a canonical JSON projection of the owner keyring, sealed under the per grant co-admin key. Null on a v2 grant. Opaque: never parsed or constrained by the database.';

COMMENT ON COLUMN public.wrapped_data_keys.wrapped_cak IS
  'Envelope v3 co-admin grant. Base64 of the per grant co-admin key, hybrid KEM wrapped to the recipient public key. Null on a v2 grant. Opaque: never parsed or constrained by the database.';

COMMENT ON COLUMN public.wrapped_data_keys.wrapped_ciphertext IS
  'Envelope v2 co-admin grant. Base64 of the 64 byte subkey blob wrapped to the recipient public key. Null on a v3 grant, which carries wrapped_cak and coadmin_keyring_ciphertext instead. By convention the algorithm column names the envelope version, but NOTHING IN THE DATABASE ENFORCES THAT AGREEMENT and nothing may be added that does, because a v3 recipient must still be able to consume a v2 grant. A reader decides which envelope a row is by which of these columns is actually present, not by trusting the algorithm string.';

ALTER TABLE public.wrapped_data_keys
  ALTER COLUMN wrapped_ciphertext DROP NOT NULL;

-- Replace the invariant the NOT NULL was carrying. Weakest rule that still
-- refuses a grant row holding no key material of either envelope version.
-- Named, so the assertion below can tell it apart from a constraint on the
-- CONTENTS of the opaque columns, which stays forbidden.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.wrapped_data_keys'::regclass
       AND conname = 'wrapped_data_keys_carries_key_material'
  ) THEN
    ALTER TABLE public.wrapped_data_keys
      ADD CONSTRAINT wrapped_data_keys_carries_key_material
      CHECK (num_nonnulls(wrapped_ciphertext, wrapped_cak) >= 1);
  END IF;
END;
$$;

-- Prove it, rather than assume the statements above did what they say. Six
-- separate assertions, because "the columns exist", "they are nullable text",
-- "nothing constrains their contents", "an empty grant is still refused",
-- "both grant shapes are insertable" and "they are no wider than the column
-- they sit beside" are six different facts and a migration that can only
-- report the first is not worth much.
DO $$
DECLARE
  new_cols text[] := ARRAY['coadmin_keyring_ciphertext', 'wrapped_cak'];
  offenders text;
  base_acl aclitem[];
BEGIN
  -- 1. Both columns exist, are text, and are nullable.
  SELECT string_agg(c, ', ' ORDER BY c) INTO offenders
  FROM unnest(new_cols) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'wrapped_data_keys'
       AND column_name = c
       AND data_type = 'text'
       AND is_nullable = 'YES'
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'expected a nullable text column and did not get one: %', offenders;
  END IF;

  -- 2. Nothing constrains the CONTENTS of either column. A length or shape
  --    constraint on opaque ciphertext is the extensibility trap this design
  --    is explicitly avoiding. The presence rule added above is deliberately
  --    excluded by name: it reads only whether a column is null, never what is
  --    inside it, so it is not a constraint on contents.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO offenders
  FROM pg_constraint
  WHERE conrelid = 'public.wrapped_data_keys'::regclass
    AND contype = 'c'
    AND conname <> 'wrapped_data_keys_carries_key_material'
    AND (pg_get_constraintdef(oid) LIKE '%coadmin_keyring_ciphertext%'
      OR pg_get_constraintdef(oid) LIKE '%wrapped_cak%');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'a check constraint now references the opaque grant columns: %', offenders;
  END IF;

  -- 3. wrapped_ciphertext is nullable, so a v3 grant row can exist without
  --    inventing a value for a v2 only column.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'wrapped_data_keys'
       AND column_name = 'wrapped_ciphertext'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'wrapped_ciphertext is still NOT NULL, a v3 grant row cannot be written';
  END IF;

  -- 4. No check constraint forces one envelope version over the other, in
  --    either direction. Both shapes stay insertable.
  SELECT string_agg(conname, ', ' ORDER BY conname) INTO offenders
  FROM pg_constraint
  WHERE conrelid = 'public.wrapped_data_keys'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%algorithm%';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'a check constraint now ties row shape to the algorithm string: %', offenders;
  END IF;

  -- 5. The presence rule really is there and really is validated, so the
  --    invariant NOT NULL used to carry has a live replacement rather than a
  --    statement that quietly did nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.wrapped_data_keys'::regclass
       AND conname = 'wrapped_data_keys_carries_key_material'
       AND contype = 'c'
       AND convalidated
  ) THEN
    RAISE EXCEPTION
      'wrapped_data_keys_carries_key_material is missing or not validated, an empty grant row would be accepted';
  END IF;

  -- 6. The two new columns carry no column level privilege of their own, so
  --    they are exactly as wide as wrapped_ciphertext already is and no wider.
  SELECT attacl INTO base_acl
  FROM pg_attribute
  WHERE attrelid = 'public.wrapped_data_keys'::regclass
    AND attname = 'wrapped_ciphertext';

  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO offenders
  FROM pg_attribute a
  WHERE a.attrelid = 'public.wrapped_data_keys'::regclass
    AND a.attname = ANY(new_cols)
    AND a.attacl IS DISTINCT FROM base_acl;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'the new grant columns carry a different column privilege from wrapped_ciphertext: %', offenders;
  END IF;
END;
$$;
