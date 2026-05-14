-- ============================================================
-- Admin Pages Schema (Phase 1 of Admin Pages plan)
-- ============================================================
-- See: docs/OrangeRails-Admin-Pages.md (draft, 2026-05-05-MESA)
--
-- Adds five tables that back two new pages:
--   /admin   -- staff super admin (run the business)
--   /portal  -- per-customer client portal (manage your account)
--
-- This migration is schema-only. Seed data (fake customers, fake
-- invoices) lives in a separate dev-only seed file, applied
-- explicitly, never in production.
--
-- Phase 1 scope: tables, RLS, staff flag, link from platforms to
-- customers. No Stripe, no payment rails wired yet.

-- ============================================================
-- 1. staff_users — flag for super-admin access
-- ============================================================
-- Using a separate table keyed by auth.users.id avoids touching
-- the auth schema directly. A row here means "this auth user can
-- see /admin and act on every customer."

CREATE TABLE IF NOT EXISTS public.staff_users (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes      TEXT
);

ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;

-- Staff can see who else is staff. Nobody else sees this table from
-- the browser; the service role bypasses RLS for backend tooling.
DROP POLICY IF EXISTS "Staff read staff_users" ON public.staff_users;
CREATE POLICY "Staff read staff_users"
  ON public.staff_users FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.staff_users s WHERE s.user_id = auth.uid()
  ));

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_users WHERE user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- ============================================================
-- 2. customers — paying entities (the business side of an account)
-- ============================================================
-- One row per paying entity. Three flavours via customer_type:
--   individual : a single human paying a flat plan
--   team       : a company paying a flat plan, plus teammates
--   developer  : a platform paying usage-based (BitBooks V3 etc.)
--
-- auth_user_id links to the primary login. Team / developer
-- customers may grant additional logins later via a customer_admins
-- table (deferred to Phase 6).

CREATE TABLE IF NOT EXISTS public.customers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id   UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  customer_type  TEXT NOT NULL CHECK (customer_type IN ('individual', 'team', 'developer')),
  plan           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'overdue', 'suspended', 'cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_auth_user ON public.customers(auth_user_id);
CREATE INDEX idx_customers_status     ON public.customers(status);
CREATE INDEX idx_customers_type       ON public.customers(customer_type);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own row" ON public.customers;
CREATE POLICY "Customers read own row"
  ON public.customers FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "Staff update customers" ON public.customers;
CREATE POLICY "Staff update customers"
  ON public.customers FOR UPDATE
  TO authenticated
  USING (public.is_staff());

-- ============================================================
-- 3. subscriptions — one active plan agreement per customer
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  plan                     TEXT NOT NULL,
  status                   TEXT NOT NULL
                           CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  stripe_subscription_id   TEXT UNIQUE,
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_customer ON public.subscriptions(customer_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own subscriptions" ON public.subscriptions;
CREATE POLICY "Customers read own subscriptions"
  ON public.subscriptions FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
    OR public.is_staff()
  );

-- ============================================================
-- 4. invoices — one row per bill
-- ============================================================

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  subscription_id     UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  amount_cents        BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL DEFAULT 'usd',
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  due_date            TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  stripe_invoice_id   TEXT UNIQUE,
  hosted_invoice_url  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_customer ON public.invoices(customer_id);
CREATE INDEX idx_invoices_status   ON public.invoices(status);
CREATE INDEX idx_invoices_due_date ON public.invoices(due_date);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own invoices" ON public.invoices;
CREATE POLICY "Customers read own invoices"
  ON public.invoices FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
    OR public.is_staff()
  );

-- ============================================================
-- 5. payments — one row per attempt to pay an invoice
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  rail                  TEXT NOT NULL CHECK (rail IN ('stripe', 'flash')),
  amount_cents          BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency              TEXT NOT NULL DEFAULT 'usd',
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  provider_payment_id   TEXT,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_invoice  ON public.payments(invoice_id);
CREATE INDEX idx_payments_customer ON public.payments(customer_id);
CREATE INDEX idx_payments_status   ON public.payments(status);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own payments" ON public.payments;
CREATE POLICY "Customers read own payments"
  ON public.payments FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
    OR public.is_staff()
  );

-- ============================================================
-- 6. audit_events — every meaningful action, who did it, when
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id   UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_customer  ON public.audit_events(customer_id);
CREATE INDEX idx_audit_events_actor     ON public.audit_events(actor_user_id);
CREATE INDEX idx_audit_events_type      ON public.audit_events(event_type);
CREATE INDEX idx_audit_events_created   ON public.audit_events(created_at DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own audit events" ON public.audit_events;
CREATE POLICY "Customers read own audit events"
  ON public.audit_events FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid())
    OR public.is_staff()
  );

-- ============================================================
-- 7. Link platforms to customers (developer-tier customers)
-- ============================================================
-- A developer customer is the business entity; a platform is the
-- API consumer they own. One customer, one platform (today).

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_platforms_customer ON public.platforms(customer_id);

-- ============================================================
-- 8. updated_at triggers
-- ============================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 9. Comments
-- ============================================================

COMMENT ON TABLE public.staff_users IS
  'Staff flag for /admin access. A row means this auth user can see and act on every customer.';

COMMENT ON TABLE public.customers IS
  'Paying entities. customer_type splits the portal into three faces: individual, team, developer.';

COMMENT ON TABLE public.subscriptions IS
  'Plan agreements. Mirrors Stripe subscription state via stripe_subscription_id (Phase 4).';

COMMENT ON TABLE public.invoices IS
  'Bills. Phase 1 stores locally; Phase 4 mirrors Stripe; later may sync to BitBooks.';

COMMENT ON TABLE public.payments IS
  'Payment attempts. rail picks the network (stripe today, flash later) without changing schema.';

COMMENT ON TABLE public.audit_events IS
  'Append-only log of every meaningful action across /admin and /portal.';

COMMENT ON FUNCTION public.is_staff() IS
  'True if the calling auth user has a row in staff_users. Used in RLS policies.';
