-- 20260723120000_or_create_platform_require_authenticated_caller.sql
--
-- Requirement: minting a platform API key must require a real account.
--
-- public.or_create_platform is SECURITY DEFINER and returns a freshly minted
-- platform API key in its result set. A definer function runs with the owner's
-- rights, and which roles hold EXECUTE on it has already drifted apart between
-- environments once, so a grant list is not a durable place to express the rule
-- "you must be signed in". The check lives inside the function instead, where it
-- holds no matter who ends up holding EXECUTE.
--
-- This is defense in depth alongside the earlier grant revoke approach
-- (20260721120000), not a replacement for it: the guard below admits any
-- signed-in end user, and this function is SECURITY DEFINER returning a live
-- platform API key, so the revoke is what actually keeps anon and authenticated
-- off EXECUTE. Both migrations must run. A live read of the cloud dev and prod
-- projects showed no anon entry and no PUBLIC entry in the function ACL; the
-- self-hosted cluster is a separate case and is not covered by that read (see
-- OR-T0861), which is why the explicit REVOKE in
-- 20260905210000_or_create_platform_explicit_acl_revoke.sql exists.
--
-- Why the check is not a bare "auth.uid() IS NULL" raise, which is the pattern
-- the other helper functions use:
--   * current_user is useless here. Inside a SECURITY DEFINER function it is
--     always the owner, never the caller.
--   * session_user does survive the definer switch. API traffic arrives on the
--     PostgREST connection role and then does SET ROLE to anon, authenticated or
--     service_role, so session_user is how an API request is told apart from a
--     direct database session (operations, psql, the migration runner). Those
--     direct sessions carry no JWT at all, so auth.uid() is NULL for them.
--   * the service key path carries a JWT whose role claim is service_role and no
--     sub claim, so auth.uid() is NULL for it too. It is exempted explicitly,
--     otherwise every server side mint stops working.
--
-- Callers that are allowed:
--   1. a signed in end user, auth.uid() is not null
--   2. the service key, JWT role claim is service_role
--   3. a direct database session that is not an API role and carries no JWT
-- Anything else, which is what anonymous API traffic looks like, is refused
-- with 42501 before any row is written.
--
-- Blast radius: there is no application call site for this function today, and
-- every mint on record came from a direct database session, which is case 3.
--
-- Idempotent: CREATE OR REPLACE, safe to re run. Reversible: replace the body
-- with the pre change definition, captured verbatim in the maintainer only
-- record for this change.

BEGIN;

CREATE OR REPLACE FUNCTION public.or_create_platform(
  p_slug                  text,
  p_display_name          text,
  p_env                   text DEFAULT 'live'::text,
  p_widget_url            text DEFAULT 'https://connect.orangerails.com'::text,
  p_app_profile_slug      text DEFAULT NULL::text,
  p_cors_origin           text DEFAULT NULL::text,
  p_bootstrap_ttl_seconds integer DEFAULT 3600
)
RETURNS TABLE(platform_id uuid, slug text, env text, api_key text, key_prefix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_catalog'
AS $function$
DECLARE
  v_random        text;
  v_full_key      text;
  v_key_hash      text;
  v_webhook_secret text;
  v_platform_id   uuid;
  v_prefix        text;
  v_jwt_claims    text;
  v_jwt_role      text;
  v_allowed       boolean;
BEGIN
  -- Authorization: see the header of this migration for why the caller is
  -- identified this way rather than with current_user or a bare auth.uid().
  v_jwt_claims := nullif(current_setting('request.jwt.claims', true), '');

  BEGIN
    v_jwt_role := v_jwt_claims::jsonb ->> 'role';
  EXCEPTION WHEN others THEN
    -- Unparseable claims are treated as no claims, which fails closed for API
    -- traffic because session_user is still an API role below.
    v_jwt_role := NULL;
  END;

  v_allowed :=
    auth.uid() IS NOT NULL
    OR v_jwt_role = 'service_role'
    OR (
      v_jwt_claims IS NULL
      AND session_user NOT IN ('anon', 'authenticated', 'authenticator')
    );

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'or_create_platform: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

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
$function$;

-- Proof, not just intent: fail the migration if the replace lost a property the
-- security of this function depends on, or if the guard did not make it in.
DO $$
DECLARE
  fn oid := to_regprocedure(
    'public.or_create_platform(text, text, text, text, text, text, integer)'
  );
  v_secdef boolean;
  v_src    text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'or_create_platform is absent after the replace';
  END IF;

  SELECT p.prosecdef, p.prosrc INTO v_secdef, v_src
  FROM pg_proc p WHERE p.oid = fn;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'or_create_platform lost SECURITY DEFINER';
  END IF;

  IF v_src NOT LIKE '%an authenticated session is required%' THEN
    RAISE EXCEPTION 'or_create_platform: the caller check is not in the body';
  END IF;
END
$$;

COMMIT;
