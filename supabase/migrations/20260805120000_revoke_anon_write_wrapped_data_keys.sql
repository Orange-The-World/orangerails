-- Remove table level write privileges on public.wrapped_data_keys from anon.
--
-- Scope: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER for the
-- anon role only. SELECT is intentionally left alone so no read path can
-- regress from this migration.
--
-- Idempotent: REVOKE is declarative; revoking a privilege that is already
-- absent is a no op.
-- Reversible: GRANT the same privileges back to the same role.
-- Service role is not affected; it bypasses GRANT based checks.

DO $$
BEGIN
  IF to_regclass('public.wrapped_data_keys') IS NULL THEN
    RAISE NOTICE 'public.wrapped_data_keys not present, nothing to revoke';
    RETURN;
  END IF;

  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
       || 'ON TABLE public.wrapped_data_keys FROM anon';

  -- PUBLIC is inherited by every role, including anon, so a privilege held
  -- there would defeat the revoke above.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
       || 'ON TABLE public.wrapped_data_keys FROM PUBLIC';
END
$$;

-- Stop future objects handing the same privileges back automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;
