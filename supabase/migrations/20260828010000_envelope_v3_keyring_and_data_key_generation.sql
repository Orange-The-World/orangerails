-- OUT-OF-ORDER-OK: verified on dev (fzwmnzmtqidumdqjdddz) 2026-09-05 that the
-- two remaining column additions in this file (connections and
-- encrypted_transactions data_key_generation) already exist with matching
-- type/default/nullability and identical column comments, so applying this
-- file now is a true no-op on those two. The third column this file
-- originally touched, user_vault_meta.keyring_ciphertext, is REMOVED below
-- because it is now owned by 20260831071500_user_vault_meta_keyring_ciphertext.sql
-- (already applied on dev), which explicitly replaces its comment; keeping
-- this file's older comment text would have regressed that on a late apply.
--
-- Envelope v3 schema: the data key generation counter.
--
-- Additive only. Two columns, both with a safe default, no backfill, no rewrite of any
-- existing value. Idempotent: every statement is guarded, so a re-run is a no-op.
--
-- WHY data_key_generation defaults to 1 and is not null: every row that exists today was
-- encrypted under the first generation of its data key, so 1 is the true value for every
-- existing row rather than a placeholder. That is what makes this migration backfill free.
-- On Postgres 11 and later a NOT NULL column with a constant default is a catalog change
-- only, so there is no table rewrite and no long lock on either table.
--
-- WHY these are new columns rather than a reuse of connections.credentials_key_version or
-- encrypted_transactions.payload_key_version: those two are envelope SCHEME selectors,
-- stamped as a hardcoded 1 at insert. They are not counters. Overloading a scheme selector
-- as a rotation counter is a mistake this codebase has already made once, so it is not
-- repeated here. Both of those columns are left completely untouched by this file.
--
-- CONSIDERED AND REJECTED: a check constraint tying data_key_generation to the keyring. The
-- keyring is opaque ciphertext, so the database cannot see inside it to validate the
-- reference, and the constraint would only create a second and wrong source of truth. A
-- generation that is missing from the keyring must fail at decrypt time in the application,
-- which already reports it clearly. Also rejected: a trigger or a monotonic guard, because
-- this counter moves only when a rotation sweep runs and no sweep exists yet.
--
-- keyring_ciphertext (public.user_vault_meta): NOT part of this file. See
-- 20260831071500_user_vault_meta_keyring_ciphertext.sql for the column, its
-- comment, its grant and its assertions.
--
-- REVERSIBLE: yes, while every row still reads the default. The undo is at the bottom of
-- this file. Once a rotation has moved a row's generation, dropping the column is data
-- loss and that undo no longer applies.

alter table public.connections
  add column if not exists data_key_generation smallint not null default 1;

comment on column public.connections.data_key_generation is
  'Envelope v3. Which generation of the vault data key this row was encrypted under. NOT the same thing as credentials_key_version, which is an envelope scheme selector and must not be used as a rotation counter.';

alter table public.encrypted_transactions
  add column if not exists data_key_generation smallint not null default 1;

comment on column public.encrypted_transactions.data_key_generation is
  'Envelope v3. Which generation of the vault data key this row was encrypted under. NOT the same thing as payload_key_version, which is an envelope scheme selector and must not be used as a rotation counter.';

-- UNDO, valid only while every row still reads the default:
--   alter table public.connections drop column if exists data_key_generation;
--   alter table public.encrypted_transactions drop column if exists data_key_generation;
