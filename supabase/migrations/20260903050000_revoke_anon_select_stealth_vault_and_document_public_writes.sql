-- Close the OR-T1566 loop (OR-T1617).
--
-- ITEM 1: revoke anon's table level SELECT on the six stealth/vault tables now
-- that their SELECT policies are TO authenticated (OR-T1566, PR #1133, merged).
-- These were deliberately left alone by 20260903000000_revoke_anon_unpoliced_table_select.sql
-- because at that time a TO public policy admitted anon; that is no longer true.
--
-- MEASURED ON DEV (fzwmnzmtqidumdqjdddz), 2026-09-03: anon's only privilege on all
-- six is table level SELECT. Column level ACL (pg_attribute.attacl, not the
-- information_schema view which reports the effective per-column privilege and
-- would false-positive here) holds anon on exactly apps and platforms, none of
-- these six, so this REVOKE cannot leave a column level grant behind.

REVOKE SELECT ON TABLE public.stealth_connections  FROM anon;
REVOKE SELECT ON TABLE public.stealth_scan_ranges  FROM anon;
REVOKE SELECT ON TABLE public.stealth_transactions FROM anon;
REVOKE SELECT ON TABLE public.stealth_utxos        FROM anon;
REVOKE SELECT ON TABLE public.workspace_admins     FROM anon;
REVOKE SELECT ON TABLE public.wrapped_data_keys    FROM anon;

-- ITEM 2: the four TO public write policies on workspace_admins and
-- wrapped_data_keys stay TO public (they gate the client admin invite path and
-- narrowing them belongs in its own reviewed change). Record why TO public is
-- safe today directly on each policy: anon holds SELECT and nothing else on
-- either table, so these are unreachable by anon for want of the underlying
-- INSERT/DELETE privilege. This is the checkable fact that stops the next
-- reader from either reflexively narrowing or reflexively trusting silence.

COMMENT ON POLICY "workspace_admins: owner can insert" ON public.workspace_admins IS
  'Left TO public deliberately (OR-T1617, 2026-09-03). Safe because anon holds SELECT '
  'and no INSERT privilege on workspace_admins (measured on dev), so this policy is '
  'unreachable by anon. If anon is ever GRANTed INSERT on this table, re-review this '
  'policy before that grant ships.';

COMMENT ON POLICY "workspace_admins: owner can delete" ON public.workspace_admins IS
  'Left TO public deliberately (OR-T1617, 2026-09-03). Safe because anon holds SELECT '
  'and no DELETE privilege on workspace_admins (measured on dev), so this policy is '
  'unreachable by anon. If anon is ever GRANTed DELETE on this table, re-review this '
  'policy before that grant ships.';

COMMENT ON POLICY "wrapped_data_keys: owner can insert for admins" ON public.wrapped_data_keys IS
  'Left TO public deliberately (OR-T1617, 2026-09-03). Safe because anon holds SELECT '
  'and no INSERT privilege on wrapped_data_keys (measured on dev), so this policy is '
  'unreachable by anon. If anon is ever GRANTed INSERT on this table, re-review this '
  'policy before that grant ships.';

COMMENT ON POLICY "wrapped_data_keys: owner can delete their wrapped keys" ON public.wrapped_data_keys IS
  'Left TO public deliberately (OR-T1617, 2026-09-03). Safe because anon holds SELECT '
  'and no DELETE privilege on wrapped_data_keys (measured on dev), so this policy is '
  'unreachable by anon. If anon is ever GRANTed DELETE on this table, re-review this '
  'policy before that grant ships.';

-- Self check. Two assertions, each of which can actually fail:
--   1. anon holds no table level SELECT on the six tables named above (equality,
--      not absence, so a re-grant elsewhere on one of these six is caught too);
--   2. anon still holds no INSERT/DELETE on workspace_admins or wrapped_data_keys,
--      the fact the comments assert. If this ever changes, the comments are stale
--      and whoever granted the privilege must re-review the four write policies.
DO $$
DECLARE
  n_select  integer;
  n_write   integer;
BEGIN
  SELECT count(*)
    INTO n_select
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE ns.nspname = 'public'
     AND c.relname IN (
       'stealth_connections', 'stealth_scan_ranges', 'stealth_transactions',
       'stealth_utxos', 'workspace_admins', 'wrapped_data_keys'
     )
     AND x.grantee = 'anon'::regrole
     AND x.privilege_type = 'SELECT';

  IF n_select <> 0 THEN
    RAISE EXCEPTION
      'anon still holds table level SELECT on one of the six stealth/vault tables. found %', n_select;
  END IF;

  SELECT count(*)
    INTO n_write
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE ns.nspname = 'public'
     AND c.relname IN ('workspace_admins', 'wrapped_data_keys')
     AND x.grantee = 'anon'::regrole
     AND x.privilege_type IN ('INSERT', 'DELETE');

  IF n_write <> 0 THEN
    RAISE EXCEPTION
      'anon holds an INSERT/DELETE privilege on workspace_admins or wrapped_data_keys. '
      'the safety argument recorded on the four TO public policies no longer holds, '
      're-review before shipping this grant. found %', n_write;
  END IF;
END
$$;
