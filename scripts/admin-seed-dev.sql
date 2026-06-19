-- ============================================================
-- Admin Pages Dev Seed (NOT a migration, run manually)
-- ============================================================
-- See: docs/OrangeRails-Admin-Pages.md (Phase 2)
--
-- Seeds five fake customers across the three customer types, with
-- subscriptions, invoices, payments, and audit events. Lets the
-- super admin and client portal pages look populated before any
-- real customers exist.
--
-- ALL fake rows use the email domain @fake.orangerails.test so they
-- are easy to wipe with one DELETE.
--
-- Apply manually in the Supabase SQL editor (NOT via supabase db push).
-- Safe to re-run: starts with a DELETE of any prior fake rows.

BEGIN;

-- Wipe any prior fake rows. CASCADE clears subscriptions, invoices,
-- payments, audit events thanks to ON DELETE CASCADE.
DELETE FROM public.customers WHERE email LIKE '%@fake.orangerails.test';

-- ============================================================
-- 1. Five fake customers
-- ============================================================

WITH inserted AS (
  INSERT INTO public.customers (name, email, customer_type, plan, status)
  VALUES
    ('Ada Lovelace',         'ada@fake.orangerails.test',         'individual', 'personal',   'active'),
    ('Grace Hopper',         'grace@fake.orangerails.test',       'individual', 'prosumer',   'overdue'),
    ('Hopper & Co',          'team@fake.orangerails.test',        'team',       'team',       'active'),
    ('Northwind Books',      'northwind@fake.orangerails.test',   'team',       'business',   'suspended'),
    ('BitBooks (developer)', 'bitbooks@fake.orangerails.test',    'developer',  'production', 'active')
  RETURNING id, email
)
INSERT INTO public.subscriptions (customer_id, plan, status, current_period_start, current_period_end)
SELECT
  i.id,
  CASE i.email
    WHEN 'ada@fake.orangerails.test'        THEN 'personal'
    WHEN 'grace@fake.orangerails.test'      THEN 'prosumer'
    WHEN 'team@fake.orangerails.test'       THEN 'team'
    WHEN 'northwind@fake.orangerails.test'  THEN 'business'
    WHEN 'bitbooks@fake.orangerails.test'   THEN 'production'
  END,
  CASE i.email
    WHEN 'grace@fake.orangerails.test'      THEN 'past_due'
    WHEN 'northwind@fake.orangerails.test'  THEN 'cancelled'
    ELSE 'active'
  END,
  now() - interval '15 days',
  now() + interval '15 days'
FROM inserted i;

-- ============================================================
-- 2. Ten fake invoices spread across the customers
-- ============================================================

INSERT INTO public.invoices (customer_id, amount_cents, currency, status, due_date, paid_at)
SELECT * FROM (
  VALUES
    -- Ada: two paid invoices
    ((SELECT id FROM public.customers WHERE email = 'ada@fake.orangerails.test'),       1900::bigint, 'usd', 'paid'::text, now() - interval '45 days', now() - interval '44 days'),
    ((SELECT id FROM public.customers WHERE email = 'ada@fake.orangerails.test'),       1900::bigint, 'usd', 'paid',         now() - interval '15 days', now() - interval '14 days'),

    -- Grace: one paid + one open (overdue)
    ((SELECT id FROM public.customers WHERE email = 'grace@fake.orangerails.test'),     4900::bigint, 'usd', 'paid',         now() - interval '40 days', now() - interval '39 days'),
    ((SELECT id FROM public.customers WHERE email = 'grace@fake.orangerails.test'),     4900::bigint, 'usd', 'open',         now() - interval '10 days', NULL),

    -- Hopper & Co: two paid
    ((SELECT id FROM public.customers WHERE email = 'team@fake.orangerails.test'),      9900::bigint, 'usd', 'paid',         now() - interval '50 days', now() - interval '49 days'),
    ((SELECT id FROM public.customers WHERE email = 'team@fake.orangerails.test'),      9900::bigint, 'usd', 'paid',         now() - interval '20 days', now() - interval '19 days'),

    -- Northwind: one paid + one void (suspended after non-payment)
    ((SELECT id FROM public.customers WHERE email = 'northwind@fake.orangerails.test'), 19900::bigint, 'usd', 'paid',        now() - interval '60 days', now() - interval '59 days'),
    ((SELECT id FROM public.customers WHERE email = 'northwind@fake.orangerails.test'), 19900::bigint, 'usd', 'uncollectible', now() - interval '20 days', NULL),

    -- BitBooks (developer): two paid usage-based
    ((SELECT id FROM public.customers WHERE email = 'bitbooks@fake.orangerails.test'),  52000::bigint, 'usd', 'paid',        now() - interval '35 days', now() - interval '34 days'),
    ((SELECT id FROM public.customers WHERE email = 'bitbooks@fake.orangerails.test'),  61500::bigint, 'usd', 'paid',        now() - interval '5 days',  now() - interval '4 days')
) AS v(customer_id, amount_cents, currency, status, due_date, paid_at);

-- ============================================================
-- 3. A payment row for every paid invoice (rail = stripe)
-- ============================================================

INSERT INTO public.payments (invoice_id, customer_id, rail, amount_cents, currency, status, provider_payment_id, created_at)
SELECT
  inv.id,
  inv.customer_id,
  'stripe',
  inv.amount_cents,
  inv.currency,
  'succeeded',
  'pi_fake_' || substr(inv.id::text, 1, 12),
  inv.paid_at
FROM public.invoices inv
JOIN public.customers c ON c.id = inv.customer_id
WHERE c.email LIKE '%@fake.orangerails.test'
  AND inv.status = 'paid';

-- ============================================================
-- 4. A handful of audit events
-- ============================================================

INSERT INTO public.audit_events (customer_id, event_type, payload, created_at)
SELECT * FROM (
  VALUES
    ((SELECT id FROM public.customers WHERE email = 'grace@fake.orangerails.test'),     'invoice.payment_failed', '{"reason":"card_declined"}'::jsonb, now() - interval '9 days'),
    ((SELECT id FROM public.customers WHERE email = 'grace@fake.orangerails.test'),     'customer.status_changed', '{"from":"active","to":"overdue"}'::jsonb, now() - interval '8 days'),
    ((SELECT id FROM public.customers WHERE email = 'northwind@fake.orangerails.test'), 'customer.status_changed', '{"from":"active","to":"suspended"}'::jsonb, now() - interval '15 days'),
    ((SELECT id FROM public.customers WHERE email = 'bitbooks@fake.orangerails.test'),  'platform.api_key_rotated', '{"by":"customer"}'::jsonb, now() - interval '30 days'),
    ((SELECT id FROM public.customers WHERE email = 'ada@fake.orangerails.test'),       'subscription.created', '{"plan":"personal"}'::jsonb, now() - interval '45 days')
) AS v(customer_id, event_type, payload, created_at);

COMMIT;

-- Verify
SELECT
  (SELECT count(*) FROM public.customers       WHERE email LIKE '%@fake.orangerails.test') AS customers,
  (SELECT count(*) FROM public.subscriptions   s JOIN public.customers c ON c.id = s.customer_id WHERE c.email LIKE '%@fake.orangerails.test') AS subscriptions,
  (SELECT count(*) FROM public.invoices        i JOIN public.customers c ON c.id = i.customer_id WHERE c.email LIKE '%@fake.orangerails.test') AS invoices,
  (SELECT count(*) FROM public.payments        p JOIN public.customers c ON c.id = p.customer_id WHERE c.email LIKE '%@fake.orangerails.test') AS payments,
  (SELECT count(*) FROM public.audit_events    a JOIN public.customers c ON c.id = a.customer_id WHERE c.email LIKE '%@fake.orangerails.test') AS audit_events;
