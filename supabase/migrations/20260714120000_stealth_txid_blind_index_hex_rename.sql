-- Rename stealth_transactions.txid_blind_index_b64 to txid_blind_index_hex.
--
-- The stored value has always been lowercase hex: blindIndex() hex-encodes the
-- HMAC-SHA256 output before it leaves the browser. The "b64" in the name is
-- simply wrong and has been since the column was created.
--
-- This is a NAME change only. No value is re-encoded, no row is rewritten, no
-- index is rebuilt. Both statements are catalog-only. Policies and indexes
-- follow the column automatically.
--
-- Guarded with IF EXISTS-style checks so a re-run is a no-op rather than an
-- error: the rename may already have been applied by hand on DEV before this
-- file reached CI.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stealth_transactions'
      and column_name = 'txid_blind_index_b64'
  ) then
    alter table public.stealth_transactions
      rename column txid_blind_index_b64 to txid_blind_index_hex;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.stealth_transactions'::regclass
      and conname = 'stealth_transactions_connection_id_txid_blind_index_b64_key'
  ) then
    alter table public.stealth_transactions
      rename constraint stealth_transactions_connection_id_txid_blind_index_b64_key
      to stealth_transactions_connection_id_txid_blind_index_hex_key;
  end if;
end $$;

comment on column public.stealth_transactions.txid_blind_index_hex is
  'Lowercase hex HMAC-SHA256 of the transaction id, keyed by the per-app stealth key, computed in the browser. 64 hex characters. The server holds no key and cannot reverse it. Used only to deduplicate a re-synced transaction against the (connection_id, txid_blind_index_hex) unique constraint.';

-- Rollback:
--   alter table public.stealth_transactions
--     rename column txid_blind_index_hex to txid_blind_index_b64;
--   alter table public.stealth_transactions
--     rename constraint stealth_transactions_connection_id_txid_blind_index_hex_key
--     to stealth_transactions_connection_id_txid_blind_index_b64_key;
