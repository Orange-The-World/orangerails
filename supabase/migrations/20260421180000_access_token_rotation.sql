-- ============================================================
-- Access token rotation — in-place rotate + expiry.
-- ============================================================
-- - list_or_access_tokens now returns expires_at and rotated_at.
-- - create_or_access_token sets a 90-day expiry on new grants.
-- - rotate_or_access_token(grant_id) generates a fresh token
--   server-side and swaps it in place (keeps the grant row id
--   stable so external apps that reference the grant don't break).
-- - Drops the old rpc_rotate_app_token which took the new token
--   from the client — insecure (client shouldn't mint tokens).

-- ── list_or_access_tokens — include expiry fields ───────────────────

DROP FUNCTION IF EXISTS public.list_or_access_tokens();

CREATE OR REPLACE FUNCTION public.list_or_access_tokens()
RETURNS TABLE(
  id           UUID,
  app_slug     TEXT,
  app_name     TEXT,
  granted_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  rotated_at   TIMESTAMPTZ
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
    g.revoked_at,
    g.expires_at,
    g.rotated_at
  FROM public.user_app_grants g
  JOIN public.apps a ON a.id = g.app_id
  WHERE g.user_id = auth.uid()
  ORDER BY g.granted_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_or_access_tokens() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_or_access_tokens() TO authenticated;

-- ── create_or_access_token — set 90-day expiry ──────────────────────

CREATE OR REPLACE FUNCTION public.create_or_access_token(app_slug TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id     UUID;
  v_raw_token  TEXT;
  v_token_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_app_id FROM public.apps WHERE slug = app_slug;
  IF v_app_id IS NULL THEN
    RAISE EXCEPTION 'Unknown app: %', app_slug;
  END IF;

  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');

  INSERT INTO public.user_app_grants (
    user_id, app_id, access_token_hash, granted_scopes, expires_at
  )
  VALUES (
    auth.uid(),
    v_app_id,
    v_token_hash,
    ARRAY['read:transactions', 'write:transactions'],
    now() + INTERVAL '90 days'
  );

  RETURN v_raw_token;
END;
$$;

-- ── rotate_or_access_token — server-side token rotation ─────────────

-- Drop the old broken rotate function that took the new token from the
-- client. Tokens must be generated server-side to ensure proper entropy
-- and prevent client-side bugs from minting predictable tokens.
DROP FUNCTION IF EXISTS public.rpc_rotate_app_token(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.rotate_or_access_token(p_grant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw_token  TEXT;
  v_token_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');

  UPDATE public.user_app_grants
  SET
    access_token_hash = v_token_hash,
    rotated_at        = now(),
    expires_at        = now() + INTERVAL '90 days',
    revoked_at        = NULL
  WHERE id      = p_grant_id
    AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grant not found or access denied';
  END IF;

  RETURN v_raw_token;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_or_access_token(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_or_access_token(UUID) TO authenticated;

COMMENT ON FUNCTION public.rotate_or_access_token(UUID) IS
  'Rotate an access token in place. Generates a fresh token server-side, '
  'updates hash + rotated_at + expires_at on the same grant row, and '
  'returns the raw token (shown once only).';
