CREATE OR REPLACE FUNCTION public.list_or_access_tokens()
RETURNS TABLE(
  id uuid,
  app_slug text,
  app_name text,
  granted_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    g.id,
    a.slug,
    a.name,
    g.granted_at,
    g.last_used_at,
    g.revoked_at
  FROM public.user_app_grants g
  JOIN public.apps a ON a.id = g.app_id
  WHERE g.user_id = auth.uid()
  ORDER BY g.granted_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_or_access_token(app_slug text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_app_id uuid;
  v_raw bytea;
  v_token text;
  v_hash text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_app_id FROM public.apps WHERE slug = app_slug;
  IF v_app_id IS NULL THEN
    RAISE EXCEPTION 'Unknown app: %', app_slug;
  END IF;

  v_raw := extensions.gen_random_bytes(32);
  v_token := encode(v_raw, 'hex');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  INSERT INTO public.user_app_grants (user_id, app_id, access_token_hash, granted_scopes)
  VALUES (auth.uid(), v_app_id, v_hash, ARRAY['read:transactions']);

  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.list_or_access_tokens() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_or_access_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_or_access_tokens() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_access_token(text) TO authenticated;