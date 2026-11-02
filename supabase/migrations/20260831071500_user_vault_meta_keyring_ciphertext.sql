-- 20260831071500_user_vault_meta_keyring_ciphertext.sql
--
-- Create public.user_vault_meta.keyring_ciphertext. It is the column the vault
-- keyring blob is stored in, and no migration in this repository has ever created
-- it.
--
-- WHY THIS FILE EXISTS
-- The column is present on hosted dev and absent on hosted prod, and no tracked
-- migration on either project created it. It reached dev out of band. That is the
-- worst shape a dependency can have: everything written against it works for the
-- person who wrote it and fails for the first customer.
--
-- 20260831120000_user_vault_meta_keyring_epoch.sql arms public.enforce_keyring_epoch,
-- whose body reads NEW.keyring_ciphertext and OLD.keyring_ciphertext. plpgsql resolves
-- record fields at RUNTIME, so on a cluster without the column both CREATE OR REPLACE
-- FUNCTION and the trigger arming succeed and the migration commits. The failure lands
-- later, on the first vault creation, as SQLSTATE 42703 with no visible link back to
-- the migration that armed it. OR-T1130 added an assertion to that file which refuses
-- to leave the guard armed when the column is missing, so the failure is now loud. This
-- file is what makes the assertion pass. Land this first.
--
-- SCOPE, deliberately narrow. This file creates ONE column and states its privilege.
-- keyring_epoch, public.user_vault_keyring_watermark and the epoch guard stay in
-- 20260831120000. Two files, two reviews.
--
-- ORDERING. Version 20260831071500 sorts ABOVE every version applied on either project
-- (dev 20260831060000, prod 20260822031500) and BELOW every pending file in the tree
-- (100000, 110000, 120000, 140000, 150000, 170000). So it applies before the epoch
-- guard regardless of the order the pending PRs merge in, and it does not push any
-- existing pending file into an out of order position.
--
-- ============================================================================
-- THE DEFINITION, AND WHY EACH PART OF IT
-- ============================================================================
--
-- text, NULLABLE, NO DEFAULT, NO CHECK.
--
-- 1. text, not bytea. Every wrapped secret and ciphertext on this table is text
--    holding base64 of the AEAD envelope: vault_verifier_ciphertext, enc_mek_ciphertext,
--    recovery_ciphertext, kem_secret_wrapped, sig_secret_wrapped. The wire format is
--    stated in 20260421100000: base64( IV[12] || AES-GCM-ciphertext || tag[16] ). One
--    column in a different representation buys nothing and costs every reader a
--    second convention to remember. text also matches what hosted dev already has,
--    which is what makes ADD COLUMN IF NOT EXISTS a true no-op there rather than a
--    silent divergence.
--
-- 2. NULLABLE, and this is a requirement rather than a convenience. The vault row is
--    created before a keyring exists: a user_vault_meta row is inserted at vault
--    creation, and the keyring blob is written after the first data key generation
--    exists to describe. Every wrapped-secret column added to this table after its
--    creation is nullable for the same reason, because a row may legitimately sit at
--    a key version that has no such blob. NOT NULL would also need a DEFAULT to be
--    addable to a populated table, and there is no honest default for a ciphertext:
--    an empty string is a blob that decrypts to nothing and would be strictly worse
--    than NULL, because NULL is unambiguously "no keyring yet" and '' is not.
--
--    CONSEQUENCE FOR THE EPOCH GUARD, stated here so nobody later "tidies" it away.
--    A vault row is created at keyring_epoch 1 with keyring_ciphertext NULL. The first
--    keyring write is an UPDATE from NULL to a blob. NULL IS DISTINCT FROM a blob, so
--    the coupled condition in enforce_keyring_epoch fires and REQUIRES the epoch to
--    rise, to 2, on that write. That is correct: writing the first keyring is a seal
--    event and must consume a generation. A client that tries to write the first
--    keyring while holding the epoch at 1 will be refused, and that refusal is the
--    guard working, not a bug in this column.
--
-- 3. NO DEFAULT. See point 2. There is no value that means "a keyring nobody has
--    sealed yet" other than NULL.
--
-- 4. NO CHECK, on shape or on length. Both were considered and both are refused, for
--    different reasons:
--
--    Shape. The value is client-produced ciphertext. A CHECK that validates its
--    structure would put the client's envelope format inside the database, where it
--    can only be changed by a migration that rewrites the whole table and cannot
--    re-encode anything. Envelope v3 is already in flight (OR-T0676), so this format
--    is known to be about to change. A server that can parse the blob is also the
--    beginning of a server that can interpret it, which is the line this product does
--    not cross.
--
--    Length. This one is a genuine call, not a shrug. An unbounded text column that
--    the row owner can write is a storage-abuse surface. It is still refused HERE
--    because: no sibling ciphertext column on this table carries a cap, so adding one
--    only here is inconsistent and gives false assurance about the others; the keyring
--    grows with legitimate use, one entry per data key generation plus one per
--    co-admin, so any number chosen before that entry format is fixed is a guess; and
--    guessing low is a one-way street that lands as a failed write on the customer
--    with the most history. The right move is a cap decided once the v3 keyring entry
--    format is settled, applied to every ciphertext column on this table in one file.
--    Filed as its own ticket rather than smuggled in here as a number nobody agreed.
--
-- 5. BACKFILL: NONE, and there is nothing to backfill. Counted immediately before
--    writing this file, 2026-08-31:
--      dev  fzwmnzmtqidumdqjdddz : user_vault_meta 0 rows, keyring_ciphertext non null 0
--      prod lcdicqalreskibdfxkzb : user_vault_meta 0 rows, column not present
--    Both clusters are empty, so adding a nullable column touches no data and there is
--    no existing blob to re-seal. Written down here while it is still true, because
--    this is the last moment at which it is free.
--
-- ============================================================================
-- PRIVILEGE, WHICH IS WHERE DEV AND PROD ACTUALLY DIVERGE
-- ============================================================================
-- Read live 2026-08-31 from pg_class.relacl and pg_attribute.attacl:
--
--   dev  : table level authenticated = r (SELECT only). INSERT and UPDATE are granted
--          PER COLUMN, on every column including keyring_ciphertext. This is the
--          OR-T0966 shape, where withdrawing one column's write privilege is possible.
--   prod : table level authenticated = arw and anon = arw. NO column level ACLs at all.
--
-- So on prod a newly added column is writable by authenticated automatically, through
-- the table grant, and on dev it would not be. The column happens to work on both
-- today, but on prod by accident and on dev by design. This file states the privilege
-- explicitly instead of inheriting it, the same reason 20260831120000 states its own:
-- a grant that arrives by inheritance disappears the same way.
--
-- The GRANT below is a no-op where the privilege is already held, and it is what keeps
-- the column writable when prod is moved onto the per column shape dev already uses.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO ABOUT anon. anon holds a TABLE LEVEL arw on
-- user_vault_meta on prod. That is real and it is not addressable from here: a column
-- level REVOKE cannot remove a table level privilege, it only removes column level
-- grants, and writing one would produce a statement that looks protective and does
-- nothing. What holds today is row level security: RLS is enabled on the table on prod
-- and all four policies name authenticated only, so anon matches no policy and reaches
-- zero rows. That is a policy standing in for a grant, which is thinner than it should
-- be, and it is filed separately rather than fixed inside a migration about one column.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, a repeatable COMMENT, a repeatable GRANT. A
-- re-run is a no-op. Note the assertions below deliberately do NOT assert that the
-- table is empty: that is true today and will not be true forever, and an assertion
-- that turns into a false failure later is worse than no assertion.
--
-- REVERSIBLE, while and only while no keyring blob exists:
--   ALTER TABLE public.user_vault_meta DROP COLUMN IF EXISTS keyring_ciphertext;
-- Drop the epoch guard in 20260831120000 first if it is armed, since its function body
-- reads this column. Once a client has sealed a real keyring, dropping this column
-- destroys the only copy of it and the undo is no longer safe. Both clusters hold 0
-- rows as of 2026-08-31, so today the undo is free.
--
-- Refs: OR-T1145, OR-T1130, OR-T0967, OR-T0796, OR-T0676, OR-T0966

BEGIN;

ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS keyring_ciphertext text;

-- This COMMENT is a REPLACEMENT, not an append. Hosted dev already carries a comment on
-- this column and applying this file overwrites it, so every fact that comment held is
-- carried through below. Read off dev 2026-08-31 before writing this: "Envelope v3.
-- Single AES-256-GCM blob holding this vault's data keys and its two PQC secrets,
-- wrapped under the MEK. Opaque ciphertext: never parsed, indexed or constrained by the
-- database. Null on a v2 vault, populated at its next unlock."
COMMENT ON COLUMN public.user_vault_meta.keyring_ciphertext IS
  'Envelope v3. A single AES-256-GCM blob holding this vault''s data keys and its two PQC secrets, wrapped under the MEK, stored as base64 of the client AEAD envelope. Opaque ciphertext: never parsed, indexed or constrained by the database, and the server holds no key that opens it. NULL is a legitimate state, not a defect: a v2 vault has none and is populated at its next unlock, and a v3 vault has none between its creation and the first data key generation. REQUIREMENT: written only by the client with the vault unlocked. Its generation counter is user_vault_meta.keyring_epoch, which trg_keyring_epoch_guard forces to rise on every change to this value, so writing this column for the first time, NULL to a blob, is a seal event and consumes an epoch. No CHECK constrains its shape on purpose: the envelope format belongs to the client and is changing under OR-T0676. OR-T1145, OR-T0967.';

-- Stated, not inherited. On prod the table level grant to authenticated already covers
-- a new column; on dev it does not, because dev grants INSERT and UPDATE per column.
-- Naming the column here makes the two projects agree and survives prod being moved
-- onto the per column shape. anon is deliberately not named: see the header.
GRANT INSERT (keyring_ciphertext), UPDATE (keyring_ciphertext) ON TABLE public.user_vault_meta TO authenticated;

-- Prove the result inside this transaction or abort. Each assertion checks a property
-- this file is responsible for. Nothing here checks a property owned by another file,
-- and nothing here checks a fact that is true today and expected to change, which is
-- why the row count is reported in the header and not asserted.
DO $assert$
DECLARE
  v_type text;
  v_nullable text;
  v_default text;
  v_anon_col int;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_type, v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_vault_meta'
     AND column_name = 'keyring_ciphertext';

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'FAIL: public.user_vault_meta.keyring_ciphertext was not created';
  END IF;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION 'FAIL: keyring_ciphertext must be text, got %', v_type;
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION 'FAIL: keyring_ciphertext must be nullable. A vault row legitimately exists before any keyring has been sealed, and there is no honest default for a ciphertext.';
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: keyring_ciphertext must have no default, got %', v_default;
  END IF;

  -- The owning client must be able to read and write its own keyring. On dev this
  -- privilege exists only because the GRANT above names the column; on prod the table
  -- grant also supplies it. Either route satisfies this, which is the point: the
  -- assertion checks the OUTCOME, not the route.
  --
  -- HONEST LIMIT, so nobody reads more into this than it says. On the per column shape
  -- dev uses, this assertion goes red if the column grant is missing, proven by removing
  -- it. On prod it CANNOT go red today, because authenticated holds a table level arw and
  -- has_column_privilege keeps answering true no matter what happens at column level. It
  -- is kept because it is exactly right for the shape prod is being moved onto (OR-T0966),
  -- and because a privilege this file grants should be a privilege this file checks. It is
  -- not, today, a guard on production.
  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'keyring_ciphertext', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot SELECT keyring_ciphertext, so a user could not read their own keyring';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'keyring_ciphertext', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot INSERT keyring_ciphertext, so vault creation could not store a keyring';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'keyring_ciphertext', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot UPDATE keyring_ciphertext, so a re-seal could never be written';
  END IF;

  -- No COLUMN LEVEL grant to anon on this column. Stated precisely because it is
  -- narrow: this cannot and does not speak to the table level grant anon holds on
  -- prod, which is covered in the header and filed separately. It can still go red,
  -- which is the whole reason it is here: it catches someone adding an anon column
  -- grant to this column later.
  SELECT count(*)
    INTO v_anon_col
    FROM pg_attribute a
   WHERE a.attrelid = 'public.user_vault_meta'::regclass
     AND a.attname = 'keyring_ciphertext'
     AND a.attacl::text LIKE '%anon=%';
  IF v_anon_col <> 0 THEN
    RAISE EXCEPTION 'FAIL: a column level grant to anon exists on keyring_ciphertext. The anonymous role must never be named on the sealed keyring.';
  END IF;

  RAISE NOTICE 'OR-T1145 ok: user_vault_meta.keyring_ciphertext is text, nullable, no default, writable by authenticated, no anon column grant';
END $assert$;

COMMIT;
