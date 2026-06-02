-- Switch api_keys.key_hash from bytea to text — simpler encoding,
-- avoids supabase-js Uint8Array serialization quirks.

BEGIN;

-- Drop existing rows (the smoke-test key won't decrypt anyway after this)
DELETE FROM client_platform.api_keys;

-- Drop the bytea constraint and recreate as text
ALTER TABLE client_platform.api_keys DROP CONSTRAINT IF EXISTS api_keys_key_hash_key;
DROP INDEX IF EXISTS client_platform.api_keys_key_hash_idx;

ALTER TABLE client_platform.api_keys ALTER COLUMN key_hash TYPE text USING encode(key_hash, 'hex');
ALTER TABLE client_platform.api_keys ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);
CREATE INDEX api_keys_key_hash_idx ON client_platform.api_keys (key_hash) WHERE revoked_at IS NULL;

COMMIT;
