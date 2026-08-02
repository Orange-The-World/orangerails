-- =============================================================================
-- Migration: connections_status_partial
-- DL-0501: Partial connections must not report status=ok
--
-- Widens connections_status_check to include 'partial'. This unblocks
-- or-sync writing status='partial' when a sync succeeds on some accounts
-- but not all, instead of collapsing to 'active' and hiding the problem.
--
-- Scope: public.connections ONLY. stealth_connections is out of scope.
-- =============================================================================

-- UP -------------------------------------------------------------------------

ALTER TABLE public.connections
  DROP CONSTRAINT IF EXISTS connections_status_check;

ALTER TABLE public.connections
  ADD CONSTRAINT connections_status_check
  CHECK (status IN ('pending', 'active', 'error', 'disconnected', 'partial'));

-- DOWN -----------------------------------------------------------------------
-- To roll back: drop the wider constraint and restore the original four values.
--
-- ALTER TABLE public.connections
--   DROP CONSTRAINT IF EXISTS connections_status_check;
--
-- ALTER TABLE public.connections
--   ADD CONSTRAINT connections_status_check
--   CHECK (status IN ('pending', 'active', 'error', 'disconnected'));
