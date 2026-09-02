-- SCRATCH INPUT, NEVER MERGE.
--
-- This file exists to make scripts/check-credential-column-grants.mjs go red,
-- so that the gate has been watched failing rather than assumed to work. It is
-- the plain form of the regression the gate is there to catch: a table wide
-- GRANT covers every column of the row, credential columns included, and no
-- RLS policy can claw that back.
--
-- Expected CI result: the "Credential column grant check" step fails with
-- public.platforms: table wide grant to anon.

GRANT SELECT ON TABLE public.platforms TO anon;
