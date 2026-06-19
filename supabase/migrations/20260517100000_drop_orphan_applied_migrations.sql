-- Audit 2026-05-16 finding #10 (Medium).
--
-- public.applied_migrations is an orphan from an early migration-tracking
-- attempt. Zero rows, zero code references (only appears in generated
-- types.ts), RLS disabled. Real migration state lives in
-- supabase_migrations.schema_migrations.
--
-- Dropping it eliminates clutter and closes an unintended-write path that
-- existed because RLS was off.

DROP TABLE IF EXISTS public.applied_migrations;
