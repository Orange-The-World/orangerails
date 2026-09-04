-- IRREVERSIBLE fixture: an unqualified DELETE followed, in the SAME EXECUTE
-- literal, by an unrelated statement that happens to carry a WHERE (OR-T2188).
--
-- WHAT THIS PINS. The DELETE FROM below has no WHERE of its own. The WHERE
-- later in the literal belongs to the UPDATE that follows it, and OR-T1709
-- folds the two into one flattened statement by blanking the literal's own
-- semicolon. A rule that asks "does WHERE appear anywhere in this statement"
-- reads that later WHERE as covering the DELETE and misses it. DELETE WITHOUT
-- WHERE must be checked per DELETE FROM occurrence, reading no further
-- forward than the next statement-starting keyword.
--
-- Expected: IRREVERSIBLE [DELETE WITHOUT WHERE].

DO $$
BEGIN
  EXECUTE 'DELETE FROM public.or_fixture_widget; UPDATE public.or_fixture_other SET note = ''x'' WHERE id = 1';
END $$;
