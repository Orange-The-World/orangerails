-- ============================================================
-- Access Token Management for Cross-App OrangeRails Integration
-- ============================================================
-- Allows authenticated OR users to generate API tokens that
-- external apps (BitBooks V3, BitBooks Personal) can use to
-- call or-sync on behalf of the user.
--
-- Tokens are stored as SHA-256 hashes only. The raw token is
-- returned once to the client and never stored in plaintext.
-- This is the same pattern used by GitHub PATs and npm tokens.

-- ── create_or_access_token(app_slug) ────────────────────────────────
-- Generates a new 256-bit random access token for the calling user
-- + the specified app. Returns the raw token (shown once only).
-- Multiple tokens per user+app are allowed (one per device/app instance).

CREATE OR REPLACE FUNCTION public.create_or_access_token(app_slug TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id UUID;
  v_raw_token TEXT;
  v_token_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_app_id FROM public.apps WHERE slug = app_slug;
  IF v_app_id IS NULL THEN
    RAISE EXCEPTION 'Unknown app: %', app_slug;
  END IF;

  -- 256-bit random token, hex-encoded (64 chars).
  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');

  INSERT INTO public.user_app_grants (user_id, app_id, access_token_hash, granted_scopes)
  VALUES (
    auth.uid(),
    v_app_id,
    v_token_hash,
    ARRAY['read:transactions', 'write:transactions']
  );

  RETURN v_raw_token;
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_access_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_or_access_token(TEXT) TO authenticated;

-- ── revoke_or_access_token(token) ───────────────────────────────────
-- Marks a token as revoked. The caller must own the token.

CREATE OR REPLACE FUNCTION public.revoke_or_access_token(raw_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_token_hash := encode(sha256(raw_token::bytea), 'hex');

  UPDATE public.user_app_grants
  SET revoked_at = now()
  WHERE access_token_hash = v_token_hash
    AND user_id = auth.uid()
    AND revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_or_access_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_or_access_token(TEXT) TO authenticated;

-- ── list_or_access_tokens() ──────────────────────────────────────────
-- Returns non-sensitive metadata about the calling user's tokens.
-- Does NOT return the raw token or the hash (token is shown once only).

CREATE OR REPLACE FUNCTION public.list_or_access_tokens()
RETURNS TABLE(
  id          UUID,
  app_slug    TEXT,
  app_name    TEXT,
  granted_at  TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.id,
    a.slug  AS app_slug,
    a.name  AS app_name,
    g.granted_at,
    g.last_used_at,
    g.revoked_at
  FROM public.user_app_grants g
  JOIN public.apps a ON a.id = g.app_id
  WHERE g.user_id = auth.uid()
  ORDER BY g.granted_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_or_access_tokens() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_or_access_tokens() TO authenticated;

-- Comments
COMMENT ON FUNCTION public.create_or_access_token(TEXT) IS
  'Generate a cross-app access token for an OR user. Raw token returned once; only hash stored.';
COMMENT ON FUNCTION public.revoke_or_access_token(TEXT) IS
  'Revoke a cross-app access token by its raw value.';
COMMENT ON FUNCTION public.list_or_access_tokens() IS
  'List access token metadata for the calling user. Never returns raw tokens or hashes.';
