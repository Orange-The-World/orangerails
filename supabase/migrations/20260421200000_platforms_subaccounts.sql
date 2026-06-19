-- ============================================================
-- Plaid-Style Platform / Subaccount Model
-- ============================================================
-- See: docs/OrangeRails-Platform-Design.md (v1.0, 2026-04-21-BIRCH)
--
-- Introduces multi-tenant platforms (BitBooks V3, BitBooks Personal,
-- future apps) and per-end-user subaccounts. Existing connections /
-- encrypted_transactions are re-keyed from auth.users.id to subaccount.
--
-- Two modes coexist:
--   - Direct mode (Individual / Team / Business pricing tiers):
--     auth.users → auto-provisioned subaccount under built-in
--     'direct' platform → connections / transactions
--   - Platform mode (Developer pricing tier — Sandbox / Production /
--     Enterprise API): platform API key → subaccount per end user → ...
--
-- ORDER MATTERS: every policy referencing connections.user_id (in any
-- table) must be dropped BEFORE attempting to drop the column. We use
-- a dynamic DO block to drop ALL policies on the affected tables
-- regardless of name, defending against policies added by future
-- migrations we don't know about yet.

-- ============================================================
-- 1. platforms — registered API consumers
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platforms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  api_key_hash  TEXT UNIQUE NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'sandbox' CHECK (tier IN ('sandbox', 'production', 'enterprise')),
  is_internal   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platforms_api_key_hash ON public.platforms(api_key_hash);

ALTER TABLE public.platforms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platforms are visible to authenticated users (metadata only)" ON public.platforms;
CREATE POLICY "Platforms are visible to authenticated users (metadata only)"
  ON public.platforms FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- 2. subaccounts — per-end-user records owned by a platform
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subaccounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES public.platforms(id) ON DELETE CASCADE,
  external_user_id  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_subaccounts_platform_external ON public.subaccounts(platform_id, external_user_id);

ALTER TABLE public.subaccounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Direct users can read their own subaccount" ON public.subaccounts;
CREATE POLICY "Direct users can read their own subaccount"
  ON public.subaccounts FOR SELECT
  TO authenticated
  USING (
    external_user_id = auth.uid()::text
    AND platform_id = (SELECT id FROM public.platforms WHERE slug = 'direct' LIMIT 1)
  );

-- ============================================================
-- 3. Seed the built-in 'direct' platform
-- ============================================================

INSERT INTO public.platforms (slug, name, api_key_hash, tier, is_internal)
VALUES (
  'direct',
  'OrangeRails Direct',
  encode(sha256(('direct-platform-internal-' || gen_random_uuid()::text)::bytea), 'hex'),
  'production',
  true
);

-- ============================================================
-- 4. Auto-provision subaccounts for existing users
-- ============================================================

INSERT INTO public.subaccounts (platform_id, external_user_id)
SELECT
  (SELECT id FROM public.platforms WHERE slug = 'direct' LIMIT 1),
  c.user_id::text
FROM (SELECT DISTINCT user_id FROM public.connections WHERE user_id IS NOT NULL) c
ON CONFLICT (platform_id, external_user_id) DO NOTHING;

-- ============================================================
-- 5. Add subaccount_id column to connections + backfill
-- ============================================================

ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS subaccount_id UUID REFERENCES public.subaccounts(id) ON DELETE CASCADE;

UPDATE public.connections AS c
SET subaccount_id = s.id
FROM public.subaccounts s
JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
WHERE c.user_id::text = s.external_user_id
  AND c.subaccount_id IS NULL;

ALTER TABLE public.connections
  ALTER COLUMN subaccount_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connections_subaccount ON public.connections(subaccount_id);

-- ============================================================
-- 6. Drop ALL policies on connections + encrypted_transactions
-- ============================================================
-- Required before dropping connections.user_id since policies on
-- BOTH tables reference it. Dynamic to catch any added later.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'connections' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.connections', r.policyname);
  END LOOP;

  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'encrypted_transactions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.encrypted_transactions', r.policyname);
  END LOOP;
END $$;

-- Drop indexes that reference user_id.
DROP INDEX IF EXISTS idx_connections_user_id;
DROP INDEX IF EXISTS idx_connections_user_provider;

-- ============================================================
-- 7. Drop user_id from connections — no dependencies remain
-- ============================================================

ALTER TABLE public.connections DROP COLUMN IF EXISTS user_id;

-- ============================================================
-- 8. Recreate RLS scoped by subaccount → direct platform
-- ============================================================

DROP POLICY IF EXISTS "Direct users can read connections via their subaccount" ON public.connections;
CREATE POLICY "Direct users can read connections via their subaccount"
  ON public.connections FOR SELECT
  TO authenticated
  USING (
    subaccount_id IN (
      SELECT s.id FROM public.subaccounts s
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can insert connections via their subaccount" ON public.connections;
CREATE POLICY "Direct users can insert connections via their subaccount"
  ON public.connections FOR INSERT
  TO authenticated
  WITH CHECK (
    subaccount_id IN (
      SELECT s.id FROM public.subaccounts s
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can update connections via their subaccount" ON public.connections;
CREATE POLICY "Direct users can update connections via their subaccount"
  ON public.connections FOR UPDATE
  TO authenticated
  USING (
    subaccount_id IN (
      SELECT s.id FROM public.subaccounts s
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can delete connections via their subaccount" ON public.connections;
CREATE POLICY "Direct users can delete connections via their subaccount"
  ON public.connections FOR DELETE
  TO authenticated
  USING (
    subaccount_id IN (
      SELECT s.id FROM public.subaccounts s
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can read transactions via their subaccount" ON public.encrypted_transactions;
CREATE POLICY "Direct users can read transactions via their subaccount"
  ON public.encrypted_transactions FOR SELECT
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can insert transactions via their subaccount" ON public.encrypted_transactions;
CREATE POLICY "Direct users can insert transactions via their subaccount"
  ON public.encrypted_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Direct users can delete transactions via their subaccount" ON public.encrypted_transactions;
CREATE POLICY "Direct users can delete transactions via their subaccount"
  ON public.encrypted_transactions FOR DELETE
  TO authenticated
  USING (
    connection_id IN (
      SELECT c.id FROM public.connections c
      JOIN public.subaccounts s ON s.id = c.subaccount_id
      JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
      WHERE s.external_user_id = auth.uid()::text
    )
  );

-- ============================================================
-- 9. Helper RPC: get_or_create_direct_subaccount()
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_or_create_direct_subaccount()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform_id  UUID;
  v_subaccount_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_platform_id FROM public.platforms WHERE slug = 'direct' LIMIT 1;
  IF v_platform_id IS NULL THEN
    RAISE EXCEPTION 'Direct platform not configured';
  END IF;

  SELECT id INTO v_subaccount_id
  FROM public.subaccounts
  WHERE platform_id = v_platform_id
    AND external_user_id = auth.uid()::text;

  IF v_subaccount_id IS NULL THEN
    INSERT INTO public.subaccounts (platform_id, external_user_id)
    VALUES (v_platform_id, auth.uid()::text)
    RETURNING id INTO v_subaccount_id;
  END IF;

  RETURN v_subaccount_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_direct_subaccount() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_direct_subaccount() TO authenticated;

COMMENT ON TABLE public.platforms IS
  'Plaid-style platform records. Built-in "direct" platform represents orangerails.com/app consumer mode; external platforms (BitBooks V3, etc.) get their own row + API key.';

COMMENT ON TABLE public.subaccounts IS
  'End users as OR sees them. Belong to one platform. Opaque external_user_id, no PII.';

COMMENT ON FUNCTION public.get_or_create_direct_subaccount() IS
  'Returns (creating if necessary) the calling user''s subaccount under the "direct" platform. Idempotent.';
