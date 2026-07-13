-- customers.analytics_id: an opaque, rotatable pseudonym for product analytics.
--
-- The identifier sent to a third party analytics tool must never be customers.id:
-- customers.id is a live foreign key (connections, invoices, vault metadata) and an
-- identifier that leaves the system cannot be recalled. analytics_id is random, not
-- derived from any other column, unique, and rotatable with a single UPDATE because
-- no foreign key depends on it.
--
-- Idempotent: a re-run neither doubles the column nor re-randomises an existing row.
-- Cost on apply: public.customers holds 0 rows in dev and prod (verified by query), so
-- the not null volatile default rewrite is instant. If customers gains real volume
-- before this lands anywhere new, split it: add nullable, batched backfill, SET NOT NULL.

alter table public.customers
  add column if not exists analytics_id uuid not null default gen_random_uuid();

create unique index if not exists customers_analytics_id_key
  on public.customers using btree (analytics_id);

comment on column public.customers.analytics_id is
  'Opaque pseudonym for product analytics. Never send customers.id to a third party. Rotatable in place: no foreign key depends on this column.';

-- Undo:
--   drop index if exists public.customers_analytics_id_key;
--   alter table public.customers drop column if exists analytics_id;
