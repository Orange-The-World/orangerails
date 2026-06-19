-- Stealth Sync: add blind_index_b64 to stealth_connections for dedup on re-add.
--
-- The browser computes blind_index = HMAC-SHA256(or_stealth_key, normalized_xpub_or_descriptor)
-- and POSTs it alongside the sealed envelope. The server stores it but cannot reverse it
-- (no key). The unique index lets us return the existing connection_id when the user
-- re-adds the same xpub instead of creating a duplicate row.
--
-- Additive migration; safe on existing rows (column nullable, constraint is partial).

alter table public.stealth_connections
  add column if not exists blind_index_b64 text;

comment on column public.stealth_connections.blind_index_b64 is
  'HMAC-SHA256 of normalized xpub/descriptor under the per-app stealth key. Used to detect duplicate adds without revealing the underlying xpub. Server cannot reverse this value.';

-- Unique only when non-null so existing rows that pre-date this column are not affected.
create unique index if not exists stealth_connections_dedup_idx
  on public.stealth_connections (app_user_id, app_slug, blind_index_b64)
  where blind_index_b64 is not null;
