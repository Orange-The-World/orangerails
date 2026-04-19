-- ============================================================
-- Fix ZKA breach: move user-content columns to ciphertext-only.
-- ============================================================
-- Context: The original connections table stored `label` and
-- `last_error` as plaintext TEXT. Both are user-facing content
-- (or contain user-facing upstream error messages) and leak
-- identifying data the server should never see.
--
-- This migration:
--   1. Adds `encrypted_label` and `encrypted_last_error` TEXT
--      columns for AES-256-GCM ciphertext (encrypted client-side
--      with the user's ORT subkey).
--   2. Drops the plaintext `label` and `last_error` columns.
--   3. Any existing rows lose their plaintext label/error — the
--      client will treat them as "(no label)" until the user
--      re-labels or the connection next syncs (for last_error).
--
-- Related: audit published 2026-04-19. See
-- docs/OrangeRails-Architecture.md §5.5 — label and last_error
-- were incorrectly omitted from the "what the server never sees"
-- list.

-- Step 1 — add encrypted columns.
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS encrypted_label TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_last_error TEXT;

-- Step 2 — drop plaintext columns. We have a small number of test
-- rows so no migration of existing data is needed; the worst case
-- is a test connection that reverts to displaying its provider_type
-- as the label until the user re-labels it.
ALTER TABLE public.connections
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS last_error;

COMMENT ON COLUMN public.connections.encrypted_label IS
  'AES-256-GCM ciphertext of the user''s friendly label for this connection. Encrypted with the user''s ORT (transactions) subkey so the server cannot read it.';

COMMENT ON COLUMN public.connections.encrypted_last_error IS
  'AES-256-GCM ciphertext of the most recent sync error message. Encrypted because upstream error bodies can contain sensitive provider info.';
