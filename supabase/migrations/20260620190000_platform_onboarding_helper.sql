-- Admin helper: create a new platform row with a fresh API key in one call.
--
-- Onboarding a new integrator becomes:
--
--   SELECT api_key FROM or_create_platform(
--     p_slug             := 'acme',
--     p_display_name     := 'Acme Finance',
--     p_env              := 'live',
--     p_widget_url       := 'https://connect.orangerails.com',
--     p_app_profile_slug := 'bitbooks-v2',
--     p_cors_origin      := 'https://acme.com'
--   ) \gset
--   \echo :api_key
--
-- (Using \gset + \echo limits the plain-key reach to the current psql
-- session's variables. Avoid SELECT * which pretty-prints to terminal
-- scrollback.)
--
-- Returns one row:
--   platform_id  uuid
--   slug         text  ('acme')
--   env          text  ('live')
--   api_key      text  (PLAIN, copy this once, you will not see it again
--                       from this function. If your Postgres has
--                       log_statement = 'all' or pgaudit recording SELECT
--                       arguments, the plain value WILL be in those logs
--                       too. Confirm logging posture before calling.)
--   key_prefix   text  ('acme_live_')
--
-- Idempotency: NOT idempotent. Second call with same slug+env throws a
-- unique_violation. That is intentional. For rotation, call
-- or_rotate_platform_key (TODO: tracked on the OR Roadmap, not in
-- this migration).
--
-- Security: SECURITY DEFINER + search_path locked. Service-role and
-- DBA can call it; PUBLIC cannot.

BEGIN;

-- ============================================================
-- 1. api_key_prefix column on platforms
-- ============================================================

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS api_key_prefix text;
COMMENT ON COLUMN public.platforms.api_key_prefix IS
  'The non-secret prefix segment of the API key, e.g. "bbv2_live_". Lets the bootstrap endpoint surface "your key starts with X" without ever returning the secret.';

-- ============================================================
-- 2. platform_key_audit table (SOC2 CC6.1 / ISO 27001 A.9.2.4)
-- ============================================================
-- Separate audit trail for key minting and rotation. Lives outside the
-- platforms row so deleting a platform does not erase the audit history.

CREATE TABLE IF NOT EXISTS public.platform_key_audit (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id     uuid        NOT NULL REFERENCES public.platforms(id) ON DELETE SET NULL,
  platform_slug   text        NOT NULL,
  env             text        NOT NULL,
  action          text        NOT NULL CHECK (action IN ('mint', 'rotate', 'revoke')),
  actor           text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_key_audit IS
  'Append-only log of platform-key lifecycle events. Populated by or_create_platform (mint), or_rotate_platform_key (rotate), or_revoke_platform_key (revoke). Used as the SOC2 evidence trail.';
COMMENT ON COLUMN public.platform_key_audit.actor IS
  'session_user at the time of the call. For mint via or_create_platform this is the service-role principal that ran the SECURITY DEFINER call.';

ALTER TABLE public.platform_key_audit ENABLE ROW LEVEL SECURITY;
-- Service-role bypasses RLS; no end-user policy here (audit log is
-- server-side only).

-- ============================================================
-- 3. or_create_platform()
-- ============================================================

CREATE OR REPLACE FUNCTION public.or_create_platform(
  p_slug             text,
  p_display_name     text,
  p_env              text     DEFAULT 'live',
  p_widget_url       text     DEFAULT 'https://connect.orangerails.com',
  p_app_profile_slug text     DEFAULT NULL,
  p_cors_origin      text     DEFAULT NULL,
  p_bootstrap_ttl_seconds integer DEFAULT 3600
)
RETURNS TABLE (
  platform_id uuid,
  slug        text,
  env         text,
  api_key     text,
  key_prefix  text
)
LANGUAGE plpgsql
SECURITY DEFINER
-- pgcrypto installs into either `extensions` (Supabase managed) or
-- `public` (self-hosted). Allow both on the search path so unqualified
-- calls to digest()/gen_random_bytes() resolve regardless.
SET search_path = extensions, public, pg_catalog
AS $$
DECLARE
  v_random        text;
  v_full_key      text;
  v_key_hash      text;
  v_webhook_secret text;
  v_platform_id   uuid;
  v_prefix        text;
BEGIN
  -- Validate inputs
  IF p_slug !~ '^[a-z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'slug must be 2-8 chars [a-z0-9] (got %)', p_slug;
  END IF;
  IF p_env NOT IN ('live', 'test', 'dev') THEN
    RAISE EXCEPTION 'env must be live | test | dev (got %)', p_env;
  END IF;
  IF p_display_name IS NULL OR length(p_display_name) < 1 OR length(p_display_name) > 200 THEN
    RAISE EXCEPTION 'display_name must be 1-200 chars (got length %)', length(p_display_name);
  END IF;

  -- Random key: 24 random bytes -> base64 (32 chars including padding)
  -- -> strip padding + map +/ to safer chars so the key stays
  -- copy-paste-friendly in env files and URL paths. base64 is
  -- uniform across the 64-char alphabet so we avoid the modulo bias
  -- that a naive % 62 over byte values introduces. Effective entropy
  -- is 192 bits (24 random bytes).
  v_random := translate(
    rtrim(encode(gen_random_bytes(24), 'base64'), '='),
    '+/', 'XY'
  );

  v_prefix    := p_slug || '_' || p_env || '_';
  v_full_key  := v_prefix || v_random;
  v_key_hash  := encode(digest(v_full_key, 'sha256'), 'hex');

  -- Webhook secret: 32 bytes -> 64 hex chars (256 bits entropy)
  v_webhook_secret := encode(gen_random_bytes(32), 'hex');

  INSERT INTO public.platforms (
    slug, name, display_name, env,
    api_key_hash, api_key_prefix,
    widget_url, webhook_secret, app_profile_slug,
    cors_origin, bootstrap_ttl_seconds,
    tier, is_internal, status
  )
  VALUES (
    p_slug, p_display_name, p_display_name, p_env,
    v_key_hash, v_prefix,
    p_widget_url, v_webhook_secret, COALESCE(p_app_profile_slug, p_slug),
    p_cors_origin, p_bootstrap_ttl_seconds,
    CASE WHEN p_env = 'live' THEN 'production' ELSE 'sandbox' END,
    false, 'active'
  )
  RETURNING id INTO v_platform_id;

  -- Audit log entry (SOC2 CC6.1)
  INSERT INTO public.platform_key_audit (
    platform_id, platform_slug, env, action, actor
  )
  VALUES (v_platform_id, p_slug, p_env, 'mint', session_user);

  RETURN QUERY SELECT
    v_platform_id,
    p_slug,
    p_env,
    v_full_key,
    v_prefix;
END;
$$;

COMMENT ON FUNCTION public.or_create_platform IS
  'Onboard a new integrator. Generates a key, hashes it, inserts the platforms row, returns the plain key ONCE via the SELECT return value. The plain key is not logged by THIS function, but is reachable via Postgres logging if log_statement, pgaudit, or auto_explain capture function results. Confirm your logging posture before calling. The mint event is recorded in platform_key_audit.';

REVOKE EXECUTE ON FUNCTION public.or_create_platform FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.or_create_platform TO service_role;

COMMIT;
