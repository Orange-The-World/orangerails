-- ORBI point-in-time rate store: exchange_rates + exchange_rate_resolutions.
--
-- The ORBI v1-rate Edge Function reads confirmed rates from exchange_rates and
-- records provider provenance in exchange_rate_resolutions. No migration ever
-- created these tables: prod holds them (created out of band) and dev has
-- neither, so on dev the endpoint dies at the rate lookup for every currency.
--
-- This captures the exact definition read live from prod on 2026-07-30 so both
-- environments converge on one recorded source of truth.
--
-- Idempotent: every statement is guarded, so on prod (tables already present)
-- this is a no-op that only records the definition in the ledger, and on dev it
-- creates the tables.
--
-- Grants are the correct posture, not a copy of prod: SELECT to anon and
-- authenticated (the public confirmed-rate read path, gated by RLS), ALL to
-- service_role (the edge function), writes explicitly revoked from anon and
-- authenticated.
--
-- Reversible: see the UNDO block at the foot of this file.

create table if not exists public.exchange_rates (
  id               uuid primary key default gen_random_uuid(),
  source_currency  text not null,
  target_currency  text not null,
  bucket_ts        timestamptz not null,
  granularity      text not null,
  product          text not null,
  rate             numeric not null,
  tier             text not null,
  composite        boolean not null default false,
  composite_via    text,
  provider_count   integer not null,
  status           text not null,
  superseded_by_id uuid references public.exchange_rates(id),
  fetched_at       timestamptz not null,
  computed_at      timestamptz not null,
  provenance       text not null default 'forward-fill',
  source_authority text not null default 'ORBI',
  constraint chk_rate_positive check (rate > 0),
  constraint chk_product_valid check (product = any (array['ORBI-M', 'ORBI-D', 'ORBI-D-authority'])),
  constraint chk_status_valid check (status = any (array['CONFIRMED', 'PENDING', 'CORRECTED'])),
  constraint chk_tier_valid check (tier = any (array['A', 'B', 'B-single', 'C-composite', 'stable'])),
  constraint chk_granularity_valid check (granularity = any (array['1m', '1d'])),
  constraint chk_composite_consistency check (
    ((composite = false) and (composite_via is null))
    or ((composite = true) and (composite_via is not null))
  ),
  constraint exchange_rates_provenance_check check (provenance = any (array['forward-fill', 'historical-backfill', 'reconciler-upgrade', 'composite-replay', 'on-demand-resolve'])),
  constraint exchange_rates_source_authority_check check (source_authority = any (array['ORBI', 'ECB', 'BANXICO', 'BCB', 'BOC', 'FED', 'BOE', 'RBA', 'SNB', 'BOJ', 'BCCH', 'BLOCKCHAIN_COM', 'BSP', 'BCRP', 'BNM', 'BI', 'BANREP', 'SARB', 'RBI', 'BITSTAMP', 'KRAKEN', 'COINBASE_EXCHANGE', 'BITFINEX', 'BITSO', 'MERCADO_BITCOIN', 'BITBANK', 'COINCHECK', 'MEMPOOL_SPACE'])),
  constraint uq_rates_pair_bucket_authority unique (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
);

create index if not exists idx_rates_lookup
  on public.exchange_rates using btree (source_currency, target_currency, granularity, product, bucket_ts desc);
create index if not exists idx_rates_status_pending
  on public.exchange_rates using btree (status, fetched_at) where (status = 'PENDING');
create index if not exists exchange_rates_provenance_idx
  on public.exchange_rates using btree (provenance);
create index if not exists exchange_rates_source_authority_idx
  on public.exchange_rates using btree (source_authority);

create table if not exists public.exchange_rate_resolutions (
  id                  uuid primary key default gen_random_uuid(),
  rate_id             uuid not null references public.exchange_rates(id) on delete cascade,
  provider_responses  jsonb not null,
  providers_succeeded text[] not null,
  providers_failed    jsonb,
  outliers_discarded  jsonb,
  median_calculation  text,
  fetched_at          timestamptz not null
);

create index if not exists idx_resolutions_rate
  on public.exchange_rate_resolutions using btree (rate_id);

alter table public.exchange_rates enable row level security;
alter table public.exchange_rate_resolutions enable row level security;

drop policy if exists "Public read access to confirmed rates" on public.exchange_rates;
create policy "Public read access to confirmed rates"
  on public.exchange_rates for select to anon, authenticated
  using (status = 'CONFIRMED');

drop policy if exists "Public read access to audit log" on public.exchange_rate_resolutions;
create policy "Public read access to audit log"
  on public.exchange_rate_resolutions for select to anon, authenticated
  using (true);

-- Correct grant posture: public reads via SELECT + the RLS policy, all writes via
-- service_role only. Writes are explicitly revoked from anon and authenticated so
-- the table-level grant matches the RLS intent (defense in depth).
revoke all on public.exchange_rates from anon, authenticated;
revoke all on public.exchange_rate_resolutions from anon, authenticated;
grant select on public.exchange_rates to anon, authenticated;
grant select on public.exchange_rate_resolutions to anon, authenticated;
grant all on public.exchange_rates to service_role;
grant all on public.exchange_rate_resolutions to service_role;

-- UNDO (reversible, run in this order because of the FK):
--   drop table if exists public.exchange_rate_resolutions;
--   drop table if exists public.exchange_rates;
