-- ORBI point-in-time rate API v1: consumer keys and usage metering.
--
-- Applies to the project that also holds exchange_rates, because the
-- Edge Function uses one client for both the key lookup and the rate
-- lookup. Splitting these tables away from exchange_rates leaves the
-- endpoint non functional.
--
-- Reversible: DROP TABLE IF EXISTS public.orbi_usage_log;
--             DROP TABLE IF EXISTS public.orbi_api_keys;
-- Idempotent: every statement is guarded, a re-run is a no-op.

create table if not exists public.orbi_api_keys (
  id            uuid primary key default gen_random_uuid(),
  consumer_id   text not null,
  consumer_name text not null,
  -- SHA-256 hex only. The CHECK makes storing a plaintext key impossible.
  key_hash      text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix    text not null,
  created_at    timestamptz not null default now(),
  created_by    text not null,
  revoked_at    timestamptz
);

create unique index if not exists orbi_api_keys_key_hash_uk
  on public.orbi_api_keys (key_hash);

create index if not exists orbi_api_keys_consumer_idx
  on public.orbi_api_keys (consumer_id) where revoked_at is null;

alter table public.orbi_api_keys enable row level security;
revoke all on public.orbi_api_keys from anon, authenticated, public;

create table if not exists public.orbi_usage_log (
  id           bigint generated always as identity primary key,
  consumer_id  text not null,
  key_prefix   text not null,
  asset        text not null,
  fiat         text not null,
  requested_at timestamptz,
  served_at    timestamptz not null default now(),
  fill_type    text not null check (fill_type in ('exact', 'forward_fill', 'gap')),
  batch_size   integer not null,
  http_status  integer not null
);

create index if not exists orbi_usage_log_consumer_served_idx
  on public.orbi_usage_log (consumer_id, served_at desc);

alter table public.orbi_usage_log enable row level security;
revoke all on public.orbi_usage_log from anon, authenticated, public;

-- No foreign key from orbi_usage_log to orbi_api_keys on purpose: usage
-- logging is fire and forget, so a constraint failure would drop metering
-- rows without protecting anything the application relies on.
--
-- RLS is enabled with no policies, so only the service role reads or
-- writes either table.
