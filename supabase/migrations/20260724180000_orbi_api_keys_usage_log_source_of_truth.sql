-- SUPERSEDED and intentionally neutralized to an inert no-op.
--
-- Canonical create migration for public.orbi_api_keys and
-- public.orbi_usage_log is 20260722000001_orbi_rate_api.sql. That file
-- carries the full guards: key_hash format CHECK, fill_type CHECK, and
-- REVOKE ALL ... FROM anon, authenticated, public.
--
-- This file previously reproduced live dev schema but WITHOUT those two
-- CHECKs and without REVOKE FROM public. It only ever ran as a no-op on
-- dev because 20260722000001 (older timestamp) created the tables first.
-- To remove the latent weaker-CREATE if migration order ever changes, its
-- body is stripped to nothing.
--
-- The dev ledger row 20260724180000 is retained on purpose: it records that
-- this version was applied, and rewriting applied history is worse hygiene
-- than an inert, documented no-op. Fresh apply: this file creates nothing;
-- 20260722000001 is the sole, fully-constrained creator of both tables.
BEGIN;
COMMIT;
