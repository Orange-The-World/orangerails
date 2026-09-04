-- supabase/checks/wrapped_data_keys_invariants.sql
--
-- Three design rules for public.wrapped_data_keys, asserted against a LIVE
-- schema rather than at one migration's apply time. Raised on DEV-0395 out of
-- DEV-0384 item 2.
--
-- THE HOLE THIS FILLS. Migration 20260828183000 asserted that no check
-- constraint on this table touches coadmin_keyring_ciphertext or wrapped_cak,
-- and excluded its own constraint BY NAME. Its follow-up 20260828234000
-- replaced that name exclusion with a property test on pg_get_constraintdef, so
-- a same-named constraint carrying a length or shape rule on the opaque columns
-- is caught. That closes the same-run half. A DO block still runs once, in
-- timestamp order, and cannot police a migration that runs AFTER it. A later
-- migration that drops and recreates wrapped_data_keys_carries_a_complete_grant
-- with a rule that reads inside a ciphertext column would apply cleanly and
-- nothing in the repo would object. This file is what objects.
--
-- WHAT IT ASSERTS, and why each one matters.
--
--   1 table_present
--     public.wrapped_data_keys resolves. Stated as its own row because it is
--     the failure that makes every other row a lie: if the table name or the
--     regclass cast is wrong, the constraint queries match nothing and zero
--     rows reads exactly like a clean pass.
--
--   2 no_content_inspection
--     No check constraint that mentions coadmin_keyring_ciphertext or
--     wrapped_cak inspects their CONTENTS. Property test on the definition, not
--     an allow list of constraint NAMES, so a future constraint cannot hide
--     behind a name this file happens to know. The grant ciphertext columns are
--     opaque, never parsed and never length pinned, because pinning a
--     ciphertext length is what made the previous co-admin construction
--     impossible to extend.
--
--     THIS IS AN ALLOW LIST OF SHAPES, NOT A DENY LIST OF FUNCTIONS, and that
--     is deliberate. 20260828234000 detects content inspection with a list of
--     function names plus a test for the tilde operator. That is sound inside a
--     migration guarding a definition it wrote itself in the same file. It is
--     not sound in a standing check, whose whole job is to catch a constraint
--     nobody has seen yet: get_byte(coadmin_keyring_ciphertext, 0) = 1,
--     md5(coadmin_keyring_ciphertext) <> '', and a bare comparison such as
--     wrapped_cak <> '\x00'::bytea all read the contents of an opaque column
--     and all pass that list. Every one of those was reproduced on the
--     development project in an aborted transaction. Extending the list would
--     leave the next unlisted function open, so instead: these columns may
--     appear ONLY as IS NULL, IS NOT NULL, or an argument to num_nonnulls.
--     Every permitted form is stripped out of the definition and anything that
--     still names the column is reported. A function call, a comparison, a cast
--     or an operator all survive that stripping, whether or not anyone
--     predicted them. The cost is the other direction of error: a legitimate
--     future rule using some other null-safe construct is refused until someone
--     widens this list on purpose. That is the direction this check should err
--     in.
--
--   3 no_algorithm_coupling
--     No check constraint on this table references the algorithm column, in
--     either direction. A v3 recipient must still be able to consume a v2
--     grant, and tying row shape to the algorithm string is what would break
--     that. Note the table's reader decides which envelope a row is by which
--     columns are present, never by trusting that string.
--
--   4 one_complete_presence_rule
--     Exactly one key material presence rule exists, and it still requires the
--     v3 pair together. This one reports SKIP, not PASS, on a project where the
--     v3 columns have not been added yet: there is nothing to assert there, and
--     saying PASS would claim an invariant that was never tested.
--
-- WHAT THIS DOES NOT PROVE. Invariant 4 is a SHAPE test on the constraint text,
-- not a semantic proof. A rule written in a different but equivalent form, say
-- NOT (wrapped_cak IS NULL OR coadmin_keyring_ciphertext IS NULL), is reported
-- FAIL even though it enforces the same thing. That is deliberate: the
-- canonical form is free to keep, and a red here is a prompt to look at a
-- deliberate change to a load bearing rule. The semantic proof, that the rule
-- actually refuses an incomplete grant row, lives in 20260828234000, which
-- validated it against real inserts in an aborted transaction.
--
-- HOW TO RUN IT BY HAND. Paste it into the SQL editor for either project, or
-- POST it to the Management API query endpoint. It reads pg_constraint and
-- information_schema only: no writes, no DDL, nothing to undo.
--
-- OUTPUT CONTRACT, and it is the point of the file. FOUR rows, always, one per
-- invariant, each with a status of PASS, FAIL, SKIP or UNKNOWN. A caller that
-- receives any other number of rows must treat the answer as UNKNOWN and say
-- so, because a query that silently matched nothing is the exact failure this
-- check exists to avoid.

WITH t AS (SELECT to_regclass('public.wrapped_data_keys') AS rel),
cons AS (
  SELECT c.conname::text AS conname,
         pg_get_constraintdef(c.oid) AS def,
         -- pg_get_constraintdef re-renders the expression with its own
         -- parentheses, so ((a IS NOT NULL) AND (b IS NOT NULL)) is what comes
         -- back from source text that had none. Comparing against the source
         -- form is a false negative waiting to happen: it happened while this
         -- file was being written and was caught only by running it. Strip
         -- parentheses and collapse whitespace before any shape test.
         regexp_replace(translate(pg_get_constraintdef(c.oid), '()', '  '), '\s+', ' ', 'g') AS norm
    FROM pg_constraint c JOIN t ON c.conrelid = t.rel
   WHERE c.contype = 'c'),
v3 AS (SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wrapped_data_keys'
          AND column_name IN ('coadmin_keyring_ciphertext', 'wrapped_cak')),
-- The key material presence rules: every check constraint that mentions any of
-- the three columns a reader opens a row with. Selected by what the constraint
-- READS, not by what it is called.
material AS (SELECT conname, def, norm FROM cons
              WHERE def LIKE '%wrapped_ciphertext%' OR def LIKE '%wrapped_cak%'
                 OR def LIKE '%coadmin_keyring_ciphertext%'),
-- Every check constraint that names an opaque grant column, with each
-- PERMITTED mention of that column stripped out. What is left is the residual:
-- if it still names the column, the constraint is doing something to that
-- column other than testing whether it is null.
opaque AS (
  SELECT conname, def,
         regexp_replace(
           regexp_replace(
             regexp_replace(norm, 'num_nonnulls [a-z0-9_, ]*', ' ', 'gi'),
             '\m(coadmin_keyring_ciphertext|wrapped_cak)\M IS NOT NULL', ' ', 'gi'),
           '\m(coadmin_keyring_ciphertext|wrapped_cak)\M IS NULL', ' ', 'gi') AS residual
    FROM cons
   WHERE norm ~* '\m(coadmin_keyring_ciphertext|wrapped_cak)\M'),
inspectors AS (SELECT string_agg(conname, ', ' ORDER BY conname) AS names FROM opaque
                WHERE residual ~* '\m(coadmin_keyring_ciphertext|wrapped_cak)\M'),
algo AS (SELECT string_agg(conname, ', ' ORDER BY conname) AS names FROM cons
          WHERE def LIKE '%algorithm%')
SELECT 1 AS ord, 'table_present' AS name,
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'FAIL' ELSE 'PASS' END AS status,
       CASE WHEN (SELECT rel FROM t) IS NULL
            THEN 'public.wrapped_data_keys does not resolve on this project, so every constraint test below would match nothing and read as clean'
            ELSE 'public.wrapped_data_keys resolves, ' || (SELECT count(*) FROM cons)::text || ' check constraint(s) read' END AS detail
UNION ALL
SELECT 2, 'no_content_inspection',
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'UNKNOWN'
            WHEN (SELECT names FROM inspectors) IS NULL THEN 'PASS' ELSE 'FAIL' END,
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'the table did not resolve, nothing was inspected'
            WHEN (SELECT names FROM inspectors) IS NULL
            THEN (SELECT count(*) FROM opaque)::text || ' check constraint(s) name an opaque grant column, and every one names it only as a null presence test'
            ELSE 'check constraint(s) doing something to an opaque grant column other than testing whether it is null: ' || (SELECT names FROM inspectors)
                 || '. Permitted forms are IS NULL, IS NOT NULL and num_nonnulls, nothing else. Residual(s): '
                 || (SELECT string_agg(conname || ' => ' || residual, ' ;; ' ORDER BY conname) FROM opaque
                      WHERE residual ~* '\m(coadmin_keyring_ciphertext|wrapped_cak)\M') END
UNION ALL
SELECT 3, 'no_algorithm_coupling',
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'UNKNOWN'
            WHEN (SELECT names FROM algo) IS NULL THEN 'PASS' ELSE 'FAIL' END,
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'the table did not resolve, nothing was inspected'
            WHEN (SELECT names FROM algo) IS NULL
            THEN 'no check constraint ties row shape to the algorithm column'
            ELSE 'check constraint(s) referencing the algorithm column: ' || (SELECT names FROM algo) END
UNION ALL
SELECT 4, 'one_complete_presence_rule',
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'UNKNOWN'
            WHEN (SELECT n FROM v3) <> 2 THEN 'SKIP'
            WHEN (SELECT count(*) FROM material) <> 1 THEN 'FAIL'
            WHEN (SELECT norm FROM material LIMIT 1) LIKE '%num_nonnulls%' THEN 'FAIL'
            WHEN (SELECT norm FROM material LIMIT 1) NOT LIKE '%wrapped_ciphertext IS NOT NULL%' THEN 'FAIL'
            WHEN (SELECT norm FROM material LIMIT 1) NOT LIKE '%wrapped_cak IS NOT NULL AND coadmin_keyring_ciphertext IS NOT NULL%'
             AND (SELECT norm FROM material LIMIT 1) NOT LIKE '%coadmin_keyring_ciphertext IS NOT NULL AND wrapped_cak IS NOT NULL%' THEN 'FAIL'
            ELSE 'PASS' END,
       CASE WHEN (SELECT rel FROM t) IS NULL THEN 'the table did not resolve, nothing was inspected'
            WHEN (SELECT n FROM v3) <> 2
              THEN 'the v3 columns are not on this project (' || (SELECT n FROM v3)::text || ' of 2), so the v3 presence rule cannot be asserted here yet'
            ELSE (SELECT count(*) FROM material)::text || ' key material presence rule(s): '
                 || coalesce((SELECT string_agg(conname || ' => ' || def, ' ;; ' ORDER BY conname) FROM material), 'none') END
ORDER BY 1;
