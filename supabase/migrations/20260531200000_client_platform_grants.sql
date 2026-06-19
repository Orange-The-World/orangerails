-- Grant Supabase API roles access to client_platform schema.
-- Without these, edge functions using service_role can't read/write the tables.
-- RLS still enforces row-level rules; this just opens the door for the role.

BEGIN;

-- Schema usage
GRANT USAGE ON SCHEMA client_platform TO postgres, service_role, authenticated, anon;

-- Table privileges
GRANT ALL ON ALL TABLES IN SCHEMA client_platform TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA client_platform TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA client_platform TO anon;

-- Sequence privileges (for bigserial columns: api_usage.id, audit_log.id)
GRANT ALL ON ALL SEQUENCES IN SCHEMA client_platform TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA client_platform TO authenticated;

-- Function execute (the SECURITY DEFINER helpers should be callable by RLS-checking code)
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA client_platform TO postgres, service_role, authenticated, anon;

-- Default privileges for any future tables/sequences added later
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT USAGE ON SEQUENCES TO authenticated;

COMMIT;

-- Verify
SELECT grantee, table_schema, table_name, string_agg(privilege_type, ',') AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'client_platform'
  AND grantee IN ('service_role', 'authenticated', 'anon')
GROUP BY grantee, table_schema, table_name
ORDER BY grantee, table_name;
