-- ============================================================
-- Plaid-Style Platform / Subaccount Model
-- ============================================================
-- See: docs/OrangeRails-Platform-Design.md (v1.0, 2026-04-21-BIRCH)
--
-- Introduces multi-tenant platforms (BitBooks V3, BitBooks Personal,
-- future apps) and per-end-user subaccounts. Existing connections /
-- encrypted_transactions are re-keyed from auth.users.id to subaccount.
--
-- Both modes coexist:
--   - Direct mode (Individual / Team / Business pricing tiers):
--     auth.users → auto-provisioned subaccount under the built-in
--     'direct' platform → connections / transactions
--   - Platform mode (Developer pricing tier — Sandbox / Production /
--     Enterprise API): platform API key → subaccount per end user → ...
--
-- This migration is non-destructive: it preserves every existing
-- connection by mapping auth.users.id → external_user_id under the
-- 'direct' platform, then swaps the foreign key on the way out.

-- ============================================================
-- 1. platforms — registered API consumers
-- ============================================================

CREATE TABLE public.platforms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  -- SHA-256 hex of the raw API key. Raw key is returned to the platform
  -- owner ONCE on creation and never stored.
  api_key_hash  TEXT UNIQUE NOT NULL,
  -- Pricing tier from /pricing Developer segment.
  tier          TEXT NOT NULL DEFAULT 'sandbox' CHECK (tier IN ('sandbox', 'production', 'enterprise')),
  -- Built-in 'direct' platform that backs orangerails.com/app users.
  is_internal   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platforms_api_key_hash ON public.platforms(api_key_hash);

-- Platforms are read-only to authenticated users (so the /app Developers
-- tab can show the user their own platforms, joined via a future
-- platform_owners table — out of scope for v1).
ALTER TABLE public.platforms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platforms are visible to authenticated users (metadata only)"
  ON public.platforms FOR SELECT
  TO authenticated
  USING (true);

-- INSERT / UPDATE / DELETE on platforms is service-role only. The
-- /app Developers tab will create platforms via an edge function that
-- validates ownership and generates the raw API key.

-- ============================================================
-- 2. subaccounts — per-end-user records owned by a platform
-- ============================================================

CREATE TABLE public.subaccounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES public.platforms(id) ON DELETE CASCADE,
  -- Opaque to OR. For 'direct' platform: auth.users.id::text. For
  -- BitBooks: the BitBooks user UUID. OR never interprets this.
  external_user_id  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, external_user_id)
);

CREATE INDEX idx_subaccounts_platform_external ON public.subaccounts(platform_id, external_user_id);

ALTER TABLE public.subaccounts ENABLE ROW LEVEL SECURITY;

-- Direct-mode users can read their own subaccount via /app. The
-- subaccount has external_user_id = auth.uid()::text on the 'direct'
-- platform.
CREATE POLICY "Direct users can read their own subaccount"
  ON public.subaccounts FOR SELECT
  TO authenticated
  USING (
    external_user_id = auth.uid()::text
    AND platform_id = (SELECT id FROM public.platforms WHERE slug = 'direct' LIMIT 1)
  );

-- Subaccount writes happen via service role from edge functions.

-- ============================================================
-- 3. Seed the built-in 'direct' platform
-- ============================================================
-- The 'direct' platform represents OR's own /app consumer mode.
-- Its API key is never used externally; edge functions resolve it
-- internally for direct-mode (auth.uid() based) requests.
--
-- The api_key_hash here is intentionally a placeholder; the edge
-- function for direct mode bypasses platform key validation and
-- looks up the 'direct' platform by slug.

INSERT INTO public.platforms (slug, name, api_key_hash, tier, is_internal)
VALUES (
  'direct',
  'OrangeRails Direct',
  encode(sha256(('direct-platform-internal-' || gen_random_uuid()::text)::bytea), 'hex'),
  'production',
  true
);

-- ============================================================
-- 4. Migrate existing connections.user_id → subaccount_id
-- ============================================================

-- Step 4a — auto-provision a subaccount for every distinct user_id
-- that already owns at least one connection.
INSERT INTO public.subaccounts (platform_id, external_user_id)
SELECT
  (SELECT id FROM public.platforms WHERE slug = 'direct' LIMIT 1),
  c.user_id::text
FROM (SELECT DISTINCT user_id FROM public.connections WHERE user_id IS NOT NULL) c
ON CONFLICT (platform_id, external_user_id) DO NOTHING;

-- Step 4b — add subaccount_id column on connections (nullable for
-- the migration window, will be made NOT NULL after backfill).
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS subaccount_id UUID REFERENCES public.subaccounts(id) ON DELETE CASCADE;

-- Step 4c — backfill subaccount_id from user_id via the join.
UPDATE public.connections AS c
SET subaccount_id = s.id
FROM public.subaccounts s
JOIN public.platforms p ON p.id = s.platform_id AND p.slug = 'direct'
WHERE c.user_id::text = s.external_user_id
  AND c.subaccount_id IS NULL;

-- Step 4d — make subaccount_id NOT NULL now that it's populated.
ALTER TABLE public.connections
  ALTER COLUMN subaccount_id SET NOT NULL;

CREATE INDEX idx_connections_subaccount ON public.connections(subaccount_id);

-- Step 4e — drop the now-redundant user_id column.
-- (Old RLS policies referencing user_id are dropped first.)
DROP POLICY IF EXISTS "Users can read own connections" ON public.connections;
DROP POLICY IF EXISTS "Users can insert own connections" ON public.connections;
DROP POLICY IF EXISTS "Users can update own connections" ON public.connections;
DROP POLICY IF EXISTS "Users can delete own connections" ON public.connections;
DROP POLICY IF EXISTS "co-admins can read owner connections" ON public.connections;
DROP POLICY IF EXISTS "co-admins can insert owner connections" ON public.connections;
DROP POLICY IF EXISTS "co-admins can update owner connections" ON public.connections;
DROP POLICY IF EXISTS "co-admins can delete owner connections" ON public.connections;

DROP INDEX IF EXISTS idx_connections_user_id;
DROP INDEX IF EXISTS idx_connections_user_provider;

ALTER TABLE public.connections DROP COLUMN IF EXISTS user_id;

-- New RLS scoped by subaccount.
-- Direct-mode users see only the subaccount that maps to their auth.uid()
-- under the 'direct' platform.
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

-- ============================================================
-- 5. encrypted_transactions RLS now traverses connection → subaccount
-- ============================================================
-- The encrypted_transactions table doesn't change (it references
-- connection_id), but its RLS policies need to be re-pointed.

DROP POLICY IF EXISTS "Users can read own transactions" ON public.encrypted_transactions;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.encrypted_transactions;
DROP POLICY IF EXISTS "Users can delete own transactions" ON public.encrypted_transactions;

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
-- 6. Helper RPC: get_or_create_direct_subaccount()
-- ============================================================
-- Called by /app on first load to ensure the current direct user has
-- a subaccount. Idempotent.

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

  -- Try to find existing subaccount.
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

-- ============================================================
-- 7. Comments
-- ============================================================

COMMENT ON TABLE public.platforms IS
  'Plaid-style platform records. BitBooks V3, BitBooks Personal, and any future API consumer registers here. The built-in "direct" platform represents orangerails.com/app consumer mode.';

COMMENT ON TABLE public.subaccounts IS
  'End users as OR sees them. Belong to exactly one platform. No PII. Identified by an opaque external_user_id that the owning platform interprets.';

COMMENT ON FUNCTION public.get_or_create_direct_subaccount() IS
  'Returns (creating if necessary) the subaccount for the calling auth.uid() under the "direct" platform. Called by /app on first load.';
