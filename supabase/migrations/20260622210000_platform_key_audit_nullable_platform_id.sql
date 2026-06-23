-- ============================================================
-- Fix platform_key_audit FK self-contradiction
-- ============================================================
-- 20260620190000_platform_onboarding_helper.sql created the audit
-- table with `platform_id uuid NOT NULL REFERENCES platforms(id) ON
-- DELETE SET NULL`. These two clauses contradict each other: when a
-- parent platform row is deleted, the FK trigger tries to SET the
-- child's platform_id to NULL, which violates the NOT NULL constraint.
-- Result: any platform with at least one audit row cannot be deleted.
--
-- Concrete symptom on OR PROD (2026-06-22): the bbv2/test orphan row
-- 173e5337-89a4-45ed-a1a3-c289a57cb4c3 has an audit entry from its
-- mint and cannot be cleaned up.
--
-- Fix: make platform_id nullable. The audit rows immutability that
-- matters for SOC2 evidence (slug, env, action, actor, created_at)
-- stays intact; only the FK reference itself goes NULL when the
-- parent is deleted. The slug+env+created_at tuple is the durable
-- identifier for the historical platform.

ALTER TABLE public.platform_key_audit
  ALTER COLUMN platform_id DROP NOT NULL;

COMMENT ON COLUMN public.platform_key_audit.platform_id IS
  'FK to platforms.id at audit time. Goes NULL when the parent platform is deleted (ON DELETE SET NULL). slug + env + created_at identify the historical platform even after deletion. Audit immutability is preserved on slug, env, action, actor, created_at.';
