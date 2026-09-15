-- Fixture for the migration reversibility classifier. NOT a real migration:
-- the 2099 timestamp keeps it out of any apply path.
--
-- What this pins: the GRANT and REVOKE exemption in executeIsUnreadable must
-- look at the token IMMEDIATELY before EXECUTE, not at the whole statement
-- text before it. Here the word revoke appears only in a comment, and a
-- comment inside a DO body is not blanked, so a prefix test sees it and
-- switches the dynamic-EXECUTE check off for the rest of the statement.
--
-- The verb is assembled by concatenation on purpose. The string "drop table"
-- never appears in this file, so no static rule can catch it: the only thing
-- standing between this file and a dropped table at apply time is the
-- dynamic-EXECUTE check itself.
--
-- Expected: IRREVERSIBLE [DYNAMIC EXECUTE].
-- Under the old prefix test this file classified REVERSIBLE, which is why it
-- is here.

do $$
declare
  v_verb text := 'dr' || 'op table ';
begin
  -- revoke of the old grants is handled in the next migration
  execute v_verb || quote_ident('or_fixture_grant_prefix');
end $$;
