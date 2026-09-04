-- SCRATCH. DO NOT MERGE. DO NOT APPLY.
--
-- This file is not a migration. It exists for one purpose: to make the new
-- CI gate, scripts/check-plaintext-credential-grants.mjs, actually go red so
-- somebody can watch it fail rather than trust that it would.
--
-- The statement below is exactly what that gate exists to refuse. A table
-- level GRANT covers every column of the row, so it hands a browser facing
-- role the whole of public.platforms, including the columns the gate
-- protects, and no row policy can claw that back.
--
-- The version is dated 2999 so it can never sort into a real apply run, and
-- the pull request carrying it is closed the moment the red run is recorded.

GRANT SELECT ON TABLE public.platforms TO anon;
