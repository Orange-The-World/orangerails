-- Add two-layer account identity columns to connections (account-fingerprint step 2).
--
-- account_emitted_id  : stable outward-facing id, random UUIDv4, minted on connect,
--                       derived from nothing. Safe to expose.
-- account_fingerprint : internal-only HMAC-SHA256 hex (64 chars) for dedup
--                       ("have we seen this account before?"). Never emitted or logged.
--
-- Both are populated by or-link-complete on every new connection insert. They are
-- nullable so pre-existing connection rows (which predate this scheme) stay valid;
-- they simply carry NULL until re-created.
--
-- Reversible:
--   ALTER TABLE public.connections
--     DROP COLUMN IF EXISTS account_fingerprint,
--     DROP COLUMN IF EXISTS account_emitted_id;
--
-- Metadata-only ALTER (nullable, no default) so no table rewrite and no long lock.
-- Idempotent (IF NOT EXISTS) so a re-run is a safe no-op.

ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS account_emitted_id uuid,
  ADD COLUMN IF NOT EXISTS account_fingerprint text;

COMMENT ON COLUMN public.connections.account_emitted_id IS
  'Stable outward-facing account id (random UUIDv4, derived from nothing). Safe to expose. See _shared/account-fingerprint.ts.';
COMMENT ON COLUMN public.connections.account_fingerprint IS
  'Internal-only HMAC-SHA256 hex for account dedup. NEVER emit, log, or return. See _shared/account-fingerprint.ts.';
