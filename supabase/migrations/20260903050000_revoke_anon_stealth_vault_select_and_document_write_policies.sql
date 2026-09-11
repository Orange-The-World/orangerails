-- OR-T1617, out of the OR-T1580/OR-T1566 option A decision. Two items, both
-- measured on dev (fzwmnzmtqidumdqjdddz) on 2026-09-03, after 20260903001500
-- (narrow_stealth_and_vault_select_policies) landed.
--
-- === ITEM 1: SIX ANON SELECT GRANTS BECOME UNPOLICED ===
-- 20260903001500 narrowed the SELECT policies on these six tables from
-- TO public to TO authenticated. The six were left out of
-- 20260903000000 (revoke_anon_unpoliced_table_select) precisely because at
-- that time they still had a policy admitting anon. That is no longer true,
-- so anon's table level SELECT grant on them is now unpoliced in exactly the
-- sense that file was written to eliminate:
--   stealth_connections, stealth_scan_ranges, stealth_transactions,
--   stealth_utxos, workspace_admins, wrapped_data_keys
--
-- NO EXPOSURE, NOTHING BREAKS: RLS with no admitting policy denies every row,
-- so anon reads nothing either way, before or after this file. This is
-- hygiene and defence in depth.
--
-- COLUMN LEVEL GRANT CHECKED: re-measured on 2026-09-03 rather than trusting
-- the note in 20260903000000, per that file's own warning that a table wide
-- REVOKE does not clear a column level grant. anon holds no column level ACL
-- entry (pg_attribute.attacl) on any of the six: the per-column rows returned
-- by information_schema.column_privileges for them are all inherited from the
-- table level grant, not separate column grants. So the table wide REVOKE
-- below is sufficient; there is nothing left over to clear.
--
-- REVERSAL: GRANT SELECT ON TABLE <name> TO anon; for each of the six.
--
-- === ITEM 2: THE FOUR REMAINING TO PUBLIC WRITE POLICIES ===
-- Left in place by the OR-T1566 option A decision and asserted by name in its
-- acceptance criterion 3:
--   workspace_admins   "workspace_admins: owner can insert"
--   workspace_admins   "workspace_admins: owner can delete"
--   wrapped_data_keys  "wrapped_data_keys: owner can insert for admins"
--   wrapped_data_keys  "wrapped_data_keys: owner can delete their wrapped keys"
-- These touch the client admin invite path, which is why they were split out
-- of the read path change in the first place. DECISION: do not narrow them in
-- this file. Re-measured on 2026-09-03: anon holds only SELECT on both
-- tables (revoked above) and no INSERT or DELETE privilege anywhere in
-- public, so a write policy addressed to public is unreachable by anon for
-- want of the underlying privilege. That argument is recorded directly on
-- each policy below with COMMENT ON POLICY, so it survives outside this
-- ticket and a future GRANT of INSERT or DELETE to anon has something to
-- contradict instead of silently making these reachable.
--
-- IDEMPOTENT: the REVOKEs are no ops when already applied. COMMENT ON POLICY
-- is a plain overwrite, safe to re-run with the same text.

REVOKE SELECT ON TABLE public.stealth_connections  FROM anon;
REVOKE SELECT ON TABLE public.stealth_scan_ranges  FROM anon;
REVOKE SELECT ON TABLE public.stealth_transactions FROM anon;
REVOKE SELECT ON TABLE public.stealth_utxos        FROM anon;
REVOKE SELECT ON TABLE public.workspace_admins     FROM anon;
REVOKE SELECT ON TABLE public.wrapped_data_keys    FROM anon;

COMMENT ON POLICY "workspace_admins: owner can insert" ON public.workspace_admins IS
  'Addressed to public, not authenticated, on purpose. Safe: anon holds no '
  'INSERT privilege on workspace_admins (checked 2026-09-03, OR-T1617), so '
  'this policy is unreachable by an anonymous session for want of the '
  'underlying grant. If anon is ever GRANTed INSERT on this table, this '
  'policy becomes reachable and must be narrowed to authenticated first.';

COMMENT ON POLICY "workspace_admins: owner can delete" ON public.workspace_admins IS
  'Addressed to public, not authenticated, on purpose. Safe: anon holds no '
  'DELETE privilege on workspace_admins (checked 2026-09-03, OR-T1617), so '
  'this policy is unreachable by an anonymous session for want of the '
  'underlying grant. If anon is ever GRANTed DELETE on this table, this '
  'policy becomes reachable and must be narrowed to authenticated first.';

COMMENT ON POLICY "wrapped_data_keys: owner can insert for admins" ON public.wrapped_data_keys IS
  'Addressed to public, not authenticated, on purpose. Safe: anon holds no '
  'INSERT privilege on wrapped_data_keys (checked 2026-09-03, OR-T1617), so '
  'this policy is unreachable by an anonymous session for want of the '
  'underlying grant. If anon is ever GRANTed INSERT on this table, this '
  'policy becomes reachable and must be narrowed to authenticated first.';

COMMENT ON POLICY "wrapped_data_keys: owner can delete their wrapped keys" ON public.wrapped_data_keys IS
  'Addressed to public, not authenticated, on purpose. Safe: anon holds no '
  'DELETE privilege on wrapped_data_keys (checked 2026-09-03, OR-T1617), so '
  'this policy is unreachable by an anonymous session for want of the '
  'underlying grant. If anon is ever GRANTed DELETE on this table, this '
  'policy becomes reachable and must be narrowed to authenticated first.';

-- Self check. Two assertions, each of which can actually fail:
--   1. anon's table level SELECT grant on the six tables is gone;
--   2. anon still holds no INSERT or DELETE anywhere on the two tables
--      carrying the four TO public write policies, so the comments above
--      remain true the moment this migration finishes.
DO $$
DECLARE
  six CONSTANT text[] := ARRAY[
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'stealth_utxos','workspace_admins','wrapped_data_keys'];
  remaining text;
  n_write   integer;
BEGIN
  SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), 'NONE')
    INTO remaining
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE ns.nspname = 'public'
     AND c.relname = ANY(six)
     AND x.grantee = 'anon'::regrole
     AND x.privilege_type = 'SELECT';

  IF remaining <> 'NONE' THEN
    RAISE EXCEPTION
      'anon still holds table level SELECT on: %. Revoke did not take effect.',
      remaining;
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
      'anon holds % INSERT/DELETE grant(s) on workspace_admins or wrapped_data_keys. '
      'The safety argument recorded in this file''s COMMENT ON POLICY text no '
      'longer holds; narrow the four TO public write policies to authenticated.',
      n_write;
  END IF;
END
$$;
