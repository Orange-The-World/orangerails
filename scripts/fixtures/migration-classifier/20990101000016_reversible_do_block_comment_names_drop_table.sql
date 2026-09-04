-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT THIS PINS. A comment inside a DO block body is a comment. It does not
-- execute when the migration is applied, so it must not be scanned as if it
-- did. This body mentions DROP TABLE in prose and does nothing irreversible.
--
-- Expected: REVERSIBLE, with no findings at all.
--
-- While a DO body was copied through character for character, the sentence
-- below reached the rules as if it were SQL and this file classified
-- IRREVERSIBLE [DROP TABLE]. The reader of that report sees a rule id and a
-- line number and has no way to tell that the rule fired on prose, so the
-- refusal is unarguable from the report. That is the false positive half.
-- 20990101000017 is the false negative half, and it is the expensive one.

DO $$
BEGIN
  -- do not DROP TABLE public.or_fixture_widget here, the rollback still needs it
  UPDATE public.or_fixture_widget SET name = name WHERE id IS NOT NULL;
END $$;
