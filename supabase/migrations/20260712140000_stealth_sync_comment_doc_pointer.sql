-- Repoint two Stealth Sync schema comments at documentation that exists in this
-- repository. Both previously ended with a cross reference to a section of a
-- planning document that is not tracked here, which left anyone reading the
-- schema with a dead end.
--
-- Comments only: no table, column, type, index, constraint, policy, or row is
-- modified. Safe to run more than once, and safe to run on a live database.
--
-- Each statement below restates the full comment body. Only the trailing
-- reference changed; the preceding sentences are unchanged from the live text.

COMMENT ON TABLE public.stealth_connections IS
  'Stealth Sync sealed envelope storage. The sealed_envelope column is opaque ciphertext to OR; only the consuming app holds the key. See docs/Stealth-Sync.md.';

COMMENT ON COLUMN public.stealth_transactions.occurred_at IS
  'Plaintext block date for indexed range queries. Matches V3 ZKA Level 2 trade-off. See docs/Stealth-Sync.md.';
