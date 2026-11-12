-- OR-T2787 B1: add pending_widget_sessions.completed_connection_id to prod
-- Idempotent; additive; reversible (see rollback comment in commit message)
ALTER TABLE public.pending_widget_sessions
  ADD COLUMN IF NOT EXISTS completed_connection_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pending_widget_sessions_completed_connection_id_fkey'
       AND conrelid = 'public.pending_widget_sessions'::regclass
  ) THEN
    ALTER TABLE public.pending_widget_sessions
      ADD CONSTRAINT pending_widget_sessions_completed_connection_id_fkey
      FOREIGN KEY (completed_connection_id) REFERENCES public.connections(id);
  END IF;
END $$;
