-- Switch api_keys.key_hash from bytea to text — simpler encoding,
-- avoids supabase-js Uint8Array serialization quirks.
-- IDEMPOTENT: detects whether key_hash is already text (PROD has had this
-- applied manually) and skips the conversion in that case.

BEGIN;

DO $$
DECLARE
  current_type text;
BEGIN
  SELECT data_type INTO current_type
  FROM information_schema.columns
  WHERE table_schema = 'client_platform'
    AND table_name = 'api_keys'
    AND column_name = 'key_hash';

  IF current_type IS NULL THEN
    -- column doesn't exist yet; nothing to do (earlier migration creates it)
    RAISE NOTICE 'client_platform.api_keys.key_hash not present; skipping';
    RETURN;
  END IF;

  IF current_type = 'text' THEN
    -- Already converted; ensure the unique constraint + index exist.
    RAISE NOTICE 'client_platform.api_keys.key_hash already text; ensuring constraint + index';
    BEGIN
      ALTER TABLE client_platform.api_keys
        ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);
    EXCEPTION WHEN duplicate_object OR duplicate_table OR unique_violation THEN NULL;
    END;
    CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx
      ON client_platform.api_keys (key_hash) WHERE revoked_at IS NULL;
    RETURN;
  END IF;

  -- key_hash is still bytea — apply original conversion
  DELETE FROM client_platform.api_keys;
  ALTER TABLE client_platform.api_keys DROP CONSTRAINT IF EXISTS api_keys_key_hash_key;
  DROP INDEX IF EXISTS client_platform.api_keys_key_hash_idx;
  ALTER TABLE client_platform.api_keys
    ALTER COLUMN key_hash TYPE text USING encode(key_hash, 'hex');
  BEGIN
    ALTER TABLE client_platform.api_keys
      ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);
  EXCEPTION WHEN duplicate_object OR duplicate_table OR unique_violation THEN NULL;
  END;
  CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx
    ON client_platform.api_keys (key_hash) WHERE revoked_at IS NULL;
END
$$;

COMMIT;
