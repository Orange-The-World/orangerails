-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT THIS PINS. The GRANT and REVOKE exemption in executeIsUnreadable is
-- anchored to the token IMMEDIATELY before EXECUTE, which is the correct
-- anchor. That anchor is only worth something if a comment cannot supply the
-- token. \s matches a newline, so a comment whose LAST WORD is revoke, sitting
-- on the line above an EXECUTE, satisfies the anchor exactly for as long as a
-- DO body reaches the rules with its comments still in it.
--
-- 20990101000015 is the sibling of this file and does NOT cover this case: its
-- comment ends in the word migration, so the anchor never matched there. The
-- two differ by one word, and the selftest passed on that word.
--
-- The verb is assembled by concatenation on purpose. The string "drop table"
-- never appears in this file, so no static rule can match it. The only thing
-- standing between this file and a dropped table at apply time is the
-- dynamic-EXECUTE check, and a comment must not be able to switch it off.
--
-- Expected: IRREVERSIBLE [DYNAMIC EXECUTE].

DO $$
DECLARE
  v_verb text := 'dr' || 'op table ';
BEGIN
  -- privileges here are handled by the revoke
  EXECUTE v_verb || quote_ident('or_fixture_widget');
END $$;
