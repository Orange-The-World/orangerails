-- Client Platform schema — foundation for app.orangerails.com
-- Holds: orgs, entitlements, members, applications, API keys, plans, usage, audit
-- Lives alongside OR's customer ledger in `public` (different schema, no overlap)
--
-- Security model:
--   - This schema holds plaintext business metadata (emails, org names, hashed keys, usage counters)
--   - NOT zero-knowledge — these are account-management records, not customer financial data
--   - Customer financial data continues to live in `public.*` under ZKA rules
--   - RLS enforces org-membership boundaries
--   - Service role (gateway edge functions) bypasses RLS to validate keys + log usage

BEGIN;

CREATE SCHEMA IF NOT EXISTS client_platform;

-- ============================================================================
-- organizations: one row per customer (self-serve signup OR sales-created)
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  billing_email   text NOT NULL,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','archived')),
  created_via     text NOT NULL
                  CHECK (created_via IN ('self-serve','sales','internal')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organizations_billing_email_idx ON client_platform.organizations (billing_email);
CREATE INDEX IF NOT EXISTS organizations_status_idx ON client_platform.organizations (status) WHERE status <> 'active';

-- ============================================================================
-- organization_entitlements: which products an org can use, and on which plan
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.organization_entitlements (
  org_id        uuid NOT NULL REFERENCES client_platform.organizations(id) ON DELETE CASCADE,
  product       text NOT NULL CHECK (product IN ('truth','orbi','or')),
  plan_id       uuid,  -- nullable for sales-custom contracts (no catalog plan)
  enabled_at    timestamptz NOT NULL DEFAULT now(),
  notes         text,
  PRIMARY KEY (org_id, product)
);

-- ============================================================================
-- organization_members: users with access to an org
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.organization_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES client_platform.organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS organization_members_user_id_idx ON client_platform.organization_members (user_id);
CREATE INDEX IF NOT EXISTS organization_members_org_id_idx ON client_platform.organization_members (org_id);

-- ============================================================================
-- applications: apps within an org (an org may run multiple)
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES client_platform.organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  allowed_origins text[],  -- CORS-style restriction; null = no restriction
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX IF NOT EXISTS applications_org_id_idx ON client_platform.applications (org_id) WHERE archived_at IS NULL;

-- ============================================================================
-- api_plans: tier catalog per product (Truth/ORBI/OR)
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.api_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product             text NOT NULL CHECK (product IN ('truth','orbi','or')),
  tier                text NOT NULL,
  display_name        text NOT NULL,
  daily_quota         bigint,           -- null = unlimited
  monthly_quota       bigint,           -- null = unlimited
  rate_per_sec        int NOT NULL DEFAULT 10,
  price_usd_monthly   numeric(10,2) NOT NULL DEFAULT 0,
  price_sats_monthly  bigint NOT NULL DEFAULT 0,
  overage_usd_per_1k  numeric(10,4) DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, tier)
);

-- ============================================================================
-- api_keys: hashed key material for an app
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES client_platform.applications(id) ON DELETE CASCADE,
  name          text NOT NULL,             -- user-chosen label ("prod", "staging")
  prefix        text NOT NULL,             -- first 8 chars of key (for UI display)
  key_hash      bytea NOT NULL UNIQUE,     -- sha256 of full key; raw key shown once at creation
  scopes        jsonb NOT NULL DEFAULT '{}'::jsonb,
                -- e.g. {"truth": true, "orbi": "builder", "or": false}
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_app_id_idx ON client_platform.api_keys (app_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON client_platform.api_keys (key_hash) WHERE revoked_at IS NULL;

-- ============================================================================
-- api_usage: one row per API call (heavy table — partition later when needed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.api_usage (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  org_id          uuid NOT NULL,        -- denormalized for fast rollups
  app_id          uuid NOT NULL,
  key_id          uuid NOT NULL,
  product         text NOT NULL CHECK (product IN ('truth','orbi','or')),
  endpoint        text NOT NULL,
  status          int NOT NULL,
  latency_ms      int,
  rows_returned   int,
  client_ip       inet
);
CREATE INDEX IF NOT EXISTS api_usage_ts_idx ON client_platform.api_usage (ts);
CREATE INDEX IF NOT EXISTS api_usage_org_ts_idx ON client_platform.api_usage (org_id, ts);
CREATE INDEX IF NOT EXISTS api_usage_key_ts_idx ON client_platform.api_usage (key_id, ts);

-- ============================================================================
-- audit_log: who did what (security + support)
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_platform.audit_log (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  org_id          uuid REFERENCES client_platform.organizations(id) ON DELETE SET NULL,
  actor_user_id   uuid,
  actor_email     text,
  action          text NOT NULL,       -- 'org.created', 'app.created', 'key.created', 'key.revoked', 'member.added', etc.
  target_type     text,                -- 'organization', 'application', 'api_key', 'member'
  target_id       text,
  client_ip       inet,
  metadata        jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_org_ts_idx ON client_platform.audit_log (org_id, ts);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON client_platform.audit_log (action);

-- ============================================================================
-- Helper functions for RLS policies
-- ============================================================================

CREATE OR REPLACE FUNCTION client_platform.is_member_of(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = client_platform, public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM client_platform.organization_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION client_platform.has_role(p_org_id uuid, p_min_role text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = client_platform, public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM client_platform.organization_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
      AND CASE p_min_role
            WHEN 'owner'  THEN role = 'owner'
            WHEN 'admin'  THEN role IN ('owner','admin')
            WHEN 'member' THEN role IN ('owner','admin','member')
          END
  );
$$;

-- ============================================================================
-- RLS enable + policies
-- ============================================================================

ALTER TABLE client_platform.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_member_read ON client_platform.organizations;
CREATE POLICY org_member_read ON client_platform.organizations
  FOR SELECT TO authenticated
  USING (client_platform.is_member_of(id));
DROP POLICY IF EXISTS org_owner_update ON client_platform.organizations;
CREATE POLICY org_owner_update ON client_platform.organizations
  FOR UPDATE TO authenticated
  USING (client_platform.has_role(id, 'owner'));

ALTER TABLE client_platform.organization_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlement_member_read ON client_platform.organization_entitlements;
CREATE POLICY entitlement_member_read ON client_platform.organization_entitlements
  FOR SELECT TO authenticated
  USING (client_platform.is_member_of(org_id));

ALTER TABLE client_platform.organization_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_self_read ON client_platform.organization_members;
CREATE POLICY member_self_read ON client_platform.organization_members
  FOR SELECT TO authenticated
  USING (client_platform.is_member_of(org_id));
DROP POLICY IF EXISTS member_owner_manage ON client_platform.organization_members;
CREATE POLICY member_owner_manage ON client_platform.organization_members
  FOR ALL TO authenticated
  USING (client_platform.has_role(org_id, 'owner'))
  WITH CHECK (client_platform.has_role(org_id, 'owner'));

ALTER TABLE client_platform.applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_member_read ON client_platform.applications;
CREATE POLICY app_member_read ON client_platform.applications
  FOR SELECT TO authenticated
  USING (client_platform.is_member_of(org_id));
DROP POLICY IF EXISTS app_admin_write ON client_platform.applications;
CREATE POLICY app_admin_write ON client_platform.applications
  FOR ALL TO authenticated
  USING (client_platform.has_role(org_id, 'admin'))
  WITH CHECK (client_platform.has_role(org_id, 'admin'));

ALTER TABLE client_platform.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS key_member_read ON client_platform.api_keys;
CREATE POLICY key_member_read ON client_platform.api_keys
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_platform.applications a
    WHERE a.id = api_keys.app_id AND client_platform.is_member_of(a.org_id)
  ));
DROP POLICY IF EXISTS key_admin_write ON client_platform.api_keys;
CREATE POLICY key_admin_write ON client_platform.api_keys
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_platform.applications a
    WHERE a.id = api_keys.app_id AND client_platform.has_role(a.org_id, 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM client_platform.applications a
    WHERE a.id = api_keys.app_id AND client_platform.has_role(a.org_id, 'admin')
  ));

ALTER TABLE client_platform.api_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_public_read ON client_platform.api_plans;
CREATE POLICY plans_public_read ON client_platform.api_plans
  FOR SELECT TO anon, authenticated
  USING (active = true);

ALTER TABLE client_platform.api_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_member_read ON client_platform.api_usage;
CREATE POLICY usage_member_read ON client_platform.api_usage
  FOR SELECT TO authenticated
  USING (client_platform.is_member_of(org_id));

ALTER TABLE client_platform.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_owner_read ON client_platform.audit_log;
CREATE POLICY audit_owner_read ON client_platform.audit_log
  FOR SELECT TO authenticated
  USING (org_id IS NOT NULL AND client_platform.has_role(org_id, 'owner'));

-- Service role bypasses all RLS automatically (Supabase convention)

-- ============================================================================
-- Seed: initial plan catalog
-- ============================================================================

INSERT INTO client_platform.api_plans (product, tier, display_name, daily_quota, monthly_quota, rate_per_sec, price_usd_monthly, price_sats_monthly, active) VALUES
  -- Truth (free, rate-limited, email-validated)
  ('truth', 'hobby',    'Hobby',    10000,    null,    5,   0,    0,     true),
  ('truth', 'builder',  'Builder',  null,     500000,  20,  0,    0,     true),
  ('truth', 'scale',    'Scale',    null,     5000000, 100, 0,    0,     true),

  -- ORBI (sales-led, but tiers exist for invoice line items)
  ('orbi', 'starter',     'Starter',     null, 100000,  20,  49,   125000,  true),
  ('orbi', 'growth',      'Growth',      null, 1000000, 100, 199,  500000,  true),
  ('orbi', 'scale',       'Scale',       null, 10000000,500, 999,  2500000, true),
  ('orbi', 'enterprise',  'Enterprise',  null, null,    2000,0,    0,       true),

  -- Orange Rails (mixed: self-serve for small devs, sales for enterprise)
  ('or', 'developer',   'Developer',   null, 10000,   10,  29,   75000,   true),
  ('or', 'business',    'Business',    null, 100000,  50,  299,  750000,  true),
  ('or', 'enterprise',  'Enterprise',  null, null,    500, 0,    0,       true);

COMMIT;
