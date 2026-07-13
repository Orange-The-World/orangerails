-- customers.analytics_id: a pseudonym for product analytics, separate from the row key.
--
-- Why a separate column: customers.id is the foreign key that joins a customer to
-- their connections, invoices and vault metadata. An identifier that leaves this
-- system for a third party analytics tool can never be un-sent, and a join key in
-- an outside event stream lets that stream be lined up against our internal records.
-- analytics_id has no relationship to any other column, so it can be sent, and it
-- can be rotated with a single UPDATE without breaking one foreign key.
--
-- Zero knowledge: this column is a random value. It carries no name, no email, no
-- plaintext of any kind, and it is not derived from any other column, so it reveals
-- nothing about the customer it labels.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS, so a
-- re-run never doubles a column, never re-randomises an existing row, and never wedges.
--
-- Table size at time of writing (VERIFIED): public.customers holds 0 rows in dev and
-- 0 rows in prod. A NOT NULL column with a volatile default (gen_random_uuid()) rewrites
-- the whole table on apply, which on an empty table is instant and locks nothing that
-- matters. If customers ever carries real volume before this lands, do NOT apply it as
-- written: split it into add-nullable, backfill in batches, then SET NOT NULL.
--
-- Reversible: the undo is at the foot of the file.

alter table public.customers
  add column if not exists analytics_id uuid not null default gen_random_uuid();

-- Unique so an analytics identity can never collide with another customer's, and so a
-- rotation that accidentally reuses a value is refused rather than silently merging two
-- customers into one funnel.
create unique index if not exists customers_analytics_id_key
  on public.customers (analytics_id);

comment on column public.customers.analytics_id is
  'Opaque per customer pseudonym for product analytics. Never a foreign key, never joined on, never derived from customers.id. Safe to send to a third party analytics tool, and safe to rotate on request with a single UPDATE. Do not replace with customers.id: a join key that leaves the system cannot be recalled.';

-- Undo:
--   drop index if exists public.customers_analytics_id_key;
--   alter table public.customers drop column if exists analytics_id;
