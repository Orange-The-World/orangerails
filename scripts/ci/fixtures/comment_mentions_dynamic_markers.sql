-- Fixture for OR-T2759's self-test.
--
-- Comments that mention every dynamic marker near a literal DROP POLICY.
-- The statement is safe; this file must NOT be flagged (exit 0).

-- EXECUTE granted to service_role only; not built with format( or %I or %s,
-- no quote_ident( and no || concatenation.
/* block comment: EXECUTE format('DROP POLICY %I', p) || quote_ident(x)
   spanning lines, with %s */
DROP POLICY IF EXISTS "stealth_utxos_service_only" ON public.stealth_utxos; -- EXECUTE
