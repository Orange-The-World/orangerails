-- IRREVERSIBLE fixture: a REVOKE and a TRUNCATE folded into ONE EXECUTE
-- literal (OR-T2188).
--
-- WHAT THIS PINS. Before OR-T1709 the semicolon inside this literal split the
-- DO body into two statements at the top level, and the second one had no
-- REVOKE of its own so the TRUNCATE rule caught it. OR-T1709 stopped that
-- split on purpose (a literal's own semicolon must not fracture the statement
-- that merely quotes it), which folds REVOKE and TRUNCATE into one flattened
-- statement and let the earlier REVOKE exempt the later TRUNCATE from a rule
-- that tested "does GRANT or REVOKE appear anywhere in this statement". The
-- TRUNCATE rule must be anchored to the token immediately before TRUNCATE
-- instead, the same way executeIsUnreadable is already anchored to the token
-- immediately before EXECUTE.
--
-- Expected: IRREVERSIBLE [TRUNCATE].

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON public.or_fixture_widget FROM anon; TRUNCATE public.or_fixture_widget';
END $$;
