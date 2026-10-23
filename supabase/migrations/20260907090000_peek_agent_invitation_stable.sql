-- ============================================================
-- peek_agent_invitation: declare STABLE
-- ============================================================
-- Ticket:  OR-T0965 (P0), acceptance item 10 (added 2026-09-02, after the
--          raw-token migration 20260831110000 was already reviewed/applied)
-- Ruling:  OR-T1000, corrected by OR-T1002 / the 2026-09-02 note on OR-T0965
--
-- WHY THIS IS SEPARATE FROM 20260831110000
-- ------------------------------------------------------------
-- The raw-token authentication fix (items 1-9) was built and reviewed
-- before this acceptance item existed, so peek_agent_invitation was left
-- at the default volatility category, VOLATILE. Read live from both
-- hosted projects on 2026-09-07: provolatile = 'v' on each. This file is
-- the fix, tracked on its own so the gap and the close are both visible.
--
-- WHY STABLE, AND WHY IT IS NOT BY ITSELF PROOF OF READ-ONLY
-- ------------------------------------------------------------
-- PostgreSQL 16 documentation, 38.7 Function Volatility Categories,
-- verbatim: "This is not a completely bulletproof test, since such
-- functions could still call VOLATILE functions that modify the
-- database." Reproduced live on PostgreSQL 16.14 (OR-C0404): a STABLE
-- plpgsql function calling a VOLATILE one wrote a row with no error and
-- provolatile stayed 's'. So the acceptance proof is the BODY, not this
-- flag: peek_agent_invitation contains no INSERT, UPDATE, DELETE, MERGE,
-- FOR UPDATE or FOR SHARE, and calls no user defined function at all
-- (confirmed by reading pg_proc.prosrc, pasted on OR-T0965). STABLE is
-- still worth declaring: the server refuses a direct write attempt inside
-- a STABLE function outright, which is a real (if partial) backstop.
--
-- SAFETY
-- ------------------------------------------------------------
-- Catalog-only change. No table lock, no rewrite of the function body,
-- idempotent (re-running is a no-op once already STABLE), reversible with
-- ALTER FUNCTION public.peek_agent_invitation(text) VOLATILE.

ALTER FUNCTION public.peek_agent_invitation(text) STABLE;

INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260907090000')
ON CONFLICT DO NOTHING;
