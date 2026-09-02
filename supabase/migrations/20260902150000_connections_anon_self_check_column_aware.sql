-- Re-run the public.connections anon self check, made column aware.
--
-- THE DEFECT THIS CORRECTS
--
-- 20260902040000_connections_column_level_select.sql closes the anon leg of
-- its self check with:
--
--   IF has_table_privilege('anon', 'public.connections', 'SELECT') THEN
--     RAISE EXCEPTION 'connections: anon can still SELECT';
--   END IF;
--
-- has_table_privilege reports TABLE level privilege only. A column level
-- grant is invisible to it. So
--
--   GRANT SELECT (strike_webhook_secret) ON public.connections TO anon;
--
-- leaves that assertion passing, and the assertion exists precisely to catch
-- that drift. The same file's comment above its authenticated leg states the
-- standard: assert the OUTCOME, and use a column aware predicate, because a
-- privilege that is not written in attacl "would read as safe". The
-- authenticated leg meets that standard. The anon leg did not.
--
-- MEASURED, dev fzwmnzmtqidumdqjdddz, 2026-09-02, on this exact table. A
-- column level SELECT was granted to anon, then removed:
--
--   with the grant in place
--     has_table_privilege('anon','public.connections','SELECT')       false
--     has_any_column_privilege('anon','public.connections','SELECT')  true
--     has_column_privilege('anon','public.connections','id','SELECT') true
--     the assertion below                RAISE: anon can still SELECT column(s): id
--     the shipped assertion              passed silently
--   after the grant was removed
--     both predicates false, and the assertion below passes
--
-- So the shipped predicate returns false while anon really can read a column,
-- and this one does not.
--
-- WHY THERE ARE TWO COPIES OF THIS ASSERTION
--
-- 20260902040000 has already run on every database that carries it, and a DO
-- block does not run again because the file changed. Amending that file in
-- place therefore re-checks nothing on an existing database. This migration
-- re-runs the corrected assertion so an EXISTING database is checked now, and
-- 20260902040000 is corrected in the same pull request so a database built
-- fresh from the migration history gets the right guard the first time.
-- Neither copy is redundant: they cover different databases.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It changes no privilege, grants nothing and revokes nothing. It is an
-- assertion only, it is side effect free, and it is safe to run repeatedly.
-- The column set, the anon REVOKE and the authenticated column grant are all
-- unchanged and are not in scope here.

DO $$
DECLARE
  anon_readable text;
BEGIN
  IF has_any_column_privilege('anon', 'public.connections', 'SELECT') THEN
    SELECT string_agg(a.attname, ', ' ORDER BY a.attname)
      INTO anon_readable
      FROM pg_attribute a
     WHERE a.attrelid = 'public.connections'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND has_column_privilege('anon', 'public.connections', a.attname, 'SELECT');

    RAISE EXCEPTION
      'connections: anon can still SELECT column(s): %', anon_readable;
  END IF;
END $$;
