-- 20260904150000_user_vault_meta_revoke_table_insert.sql
-- Requires: 20260831071500, 20260831120000, 20260828163000
--
-- Take table level INSERT on public.user_vault_meta back off authenticated.
-- The column level INSERT grants that already exist on the 17 columns the
-- member vault path writes are untouched in shape, only re-stated because a
-- table level REVOKE of a privilege clears column level grants of that same
-- privilege too (see THE TRAP below).
--
-- WHY THIS EXISTS
-- 20260831071500 line 159 reads:
--   GRANT SELECT, INSERT, UPDATE (keyring_ciphertext) ON TABLE public.user_vault_meta TO authenticated;
-- In PostgreSQL a column list binds only to the privilege immediately in
-- front of it. So that statement granted TABLE level SELECT (a no-op,
-- authenticated already held it), TABLE level INSERT (the defect: it covers
-- every column, present and future, not only keyring_ciphertext), and COLUMN
-- level UPDATE on keyring_ciphertext (correct, and this file does not touch
-- it). Found by orangerails/dba, OR-T2044.
--
-- MEASURED, dev fzwmnzmtqidumdqjdddz, 2026-09-04, before this file:
--   pg_class.relacl authenticated      : SELECT, INSERT
--   pg_attribute.attacl authenticated  : INSERT and UPDATE on exactly the 17
--     columns named below, and on no other column. workspace_key_id is NOT
--     one of them: its only column ACL is or_agent_reader SELECT (OR-T1488).
--
-- WHAT THE DEFECT ACTUALLY COSTS. With the table level INSERT in place,
-- authenticated can INSERT a value into workspace_key_id, the column every
-- row level security policy on wrapped_data_keys reads to decide who owns a
-- key. The column level shape must not admit that, and did not before this
-- statement was ever run, and does not after this file.
--
-- THE TRAP, and it is the whole reason this is not a one line REVOKE.
--   REVOKE INSERT ON TABLE public.user_vault_meta FROM authenticated
-- also revokes the column level INSERT grant on all 17 columns above, because
-- a table level REVOKE of a privilege clears every column level ACL entry for
-- that same privilege and grantee. VERIFIED directly before writing this
-- file, on a scratch table on this same dev project, dropped afterward: a
-- table level GRANT INSERT plus a column level GRANT INSERT on two columns
-- plus a column level GRANT UPDATE on one of them, then REVOKE INSERT ON
-- TABLE ... FROM authenticated, left the column level UPDATE grant in place
-- and removed both INSERT grants, table level and column level. Doing only
-- the REVOKE on user_vault_meta breaks signup and vault creation, the same
-- trap already recorded on OR-T1449. So this file revokes the table level
-- grant and re-grants INSERT on the 17 columns in the same transaction,
-- naming them explicitly rather than deriving them from the catalogue: the
-- acceptance for this file is exactly these columns and no others, and a name
-- written down is a claim that can be checked, where a name read back from
-- the table it just changed cannot disagree with itself.
--
-- WHY A NEW VERSION, NOT AN EDIT TO 20260831071500. That version is already
-- in the ledger on dev (supabase_migrations.schema_migrations), and the apply
-- loop in .github/workflows/supabase-deploy.yml selects pending files by set
-- difference against the ledger: an applied version is skipped forever, so
-- editing that file changes nothing on a project that already ran it. Line
-- 159 of that file is corrected in this same pull request anyway, so a FRESH
-- project or PROD, neither of which has applied that version, gets the right
-- grant on first apply and never carries the defect at all. That correction
-- does not renumber the file and does not depend on this migration running:
-- this file exists only for the one project that already has the defect
-- live, dev.
--
-- SCOPE. Dev only. Prod does not have keyring_ciphertext (OR-T2044, OR-T1145)
-- and still carries the old table wide authenticated=arw shape on this
-- table, so 20260831071500 has never run there and never granted this on
-- prod. Once prod moves onto the per column shape and applies the corrected
-- file, it never passes through the defective state, so it needs no
-- equivalent migration.
--
-- IDEMPOTENT. REVOKE and GRANT are declarative; a re-run converges on the
-- same state. TRANSACTIONAL: BEGIN/COMMIT wraps every statement including the
-- assertions, so a failed assertion aborts the whole file rather than
-- leaving the table mid change.
--
-- REVERSIBLE:
--   REVOKE INSERT (created_at, enc_mek_ciphertext, kdf_algorithm, kdf_params,
--     kem_public_key, kem_secret_wrapped, keyring_ciphertext, keyring_epoch,
--     pqc_key_version, recovery_ciphertext, sig_public_key, sig_secret_wrapped,
--     updated_at, user_id, vault_key_version, vault_salt,
--     vault_verifier_ciphertext)
--     ON TABLE public.user_vault_meta FROM authenticated;
--   GRANT INSERT ON TABLE public.user_vault_meta TO authenticated;
-- That restores the table wide grant, and with it the defect. Written down
-- because a rollback path has to exist, not because it is a safe end state.
--
-- Refs: OR-T2044, OR-T2065, OR-T1449, OR-T0966, OR-T1130

BEGIN;

REVOKE INSERT ON TABLE public.user_vault_meta FROM authenticated;

GRANT INSERT (
  created_at,
  enc_mek_ciphertext,
  kdf_algorithm,
  kdf_params,
  kem_public_key,
  kem_secret_wrapped,
  keyring_ciphertext,
  keyring_epoch,
  pqc_key_version,
  recovery_ciphertext,
  sig_public_key,
  sig_secret_wrapped,
  updated_at,
  user_id,
  vault_key_version,
  vault_salt,
  vault_verifier_ciphertext
) ON TABLE public.user_vault_meta TO authenticated;

-- Prove the result inside this transaction or abort. Both assertions check
-- the ABSENCE of a wider grant, not only the presence of the intended one,
-- because the statement that caused the defect would have passed any
-- assertion written from the author's intent: it granted MORE than intended,
-- and a check that only confirms the intended privilege is present says
-- nothing about the extra one. OR-T2044.
DO $assert$
DECLARE
  v_table_extra text;
  v_col_extra   text;
  v_col_missing text;
  member_writable_columns CONSTANT text[] := ARRAY[
    'created_at', 'enc_mek_ciphertext', 'kdf_algorithm', 'kdf_params',
    'kem_public_key', 'kem_secret_wrapped', 'keyring_ciphertext',
    'keyring_epoch', 'pqc_key_version', 'recovery_ciphertext',
    'sig_public_key', 'sig_secret_wrapped', 'updated_at', 'user_id',
    'vault_key_version', 'vault_salt', 'vault_verifier_ciphertext'
  ];
BEGIN
  -- 1. relacl for authenticated on this table must be exactly SELECT. Read
  --    through aclexplode rather than has_table_privilege with a fixed list,
  --    so a privilege nobody thought to name is still caught.
  SELECT string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type)
    INTO v_table_extra
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.user_vault_meta'::regclass
     AND a.grantee = 'authenticated'::regrole
     AND a.privilege_type <> 'SELECT';
  IF v_table_extra IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL: authenticated holds table level privilege(s) beyond SELECT on user_vault_meta: %', v_table_extra;
  END IF;

  -- 2. attacl must carry INSERT for authenticated on exactly the 17 columns
  --    above and on no others. Checked in both directions: a column outside
  --    the list that still has INSERT is the defect returning, and a column
  --    inside the list that lost INSERT breaks vault creation.
  SELECT string_agg(att.attname, ', ' ORDER BY att.attname)
    INTO v_col_extra
    FROM pg_attribute att
   WHERE att.attrelid = 'public.user_vault_meta'::regclass
     AND att.attnum > 0
     AND NOT att.attisdropped
     AND NOT (att.attname = ANY (member_writable_columns))
     AND has_column_privilege('authenticated', 'public.user_vault_meta', att.attname, 'INSERT');
  IF v_col_extra IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL: authenticated can INSERT column(s) outside the 17 column allow list: %', v_col_extra;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c)
    INTO v_col_missing
    FROM unnest(member_writable_columns) AS c
   WHERE NOT has_column_privilege('authenticated', 'public.user_vault_meta', c, 'INSERT');
  IF v_col_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL: authenticated lost INSERT on column(s) vault creation needs: %', v_col_missing;
  END IF;

  -- 3. Named explicitly, because it is the column this file exists for.
  --    Redundant against assertion 2 and kept anyway: it puts the
  --    requirement itself in the failure message.
  IF has_column_privilege('authenticated', 'public.user_vault_meta', 'workspace_key_id', 'INSERT') THEN
    RAISE EXCEPTION
      'FAIL: authenticated can INSERT user_vault_meta.workspace_key_id, the owner identity exclusion is gone';
  END IF;

  RAISE NOTICE 'OR-T2065 ok: authenticated holds table level SELECT only, and column level INSERT on exactly the 17 member writable columns, on public.user_vault_meta';
END $assert$;

COMMIT;
