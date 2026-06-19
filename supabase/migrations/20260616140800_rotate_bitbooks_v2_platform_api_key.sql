-- Rotate the bitbooks-v2 platform API key.
--
-- Why: the raw key minted at platform-registration time (migration
-- 20260424120000) was held only by the V2 maintainer and was not recorded
-- in a shared canonical secret store. Rotating to a freshly-generated key
-- closes the gap so both sides keep a copy.
--
-- Cutover plan (coordinated to minimise prod auth window):
--   1. The V2 maintainer updates OR_PLATFORM_API_KEY on the consuming app
--      to the new value and stages a redeploy.
--   2. The V2 maintainer confirms ready.
--   3. THIS migration is merged to OR prod (CI applies via Mgmt API).
--   4. The external platform maintainer triggers the redeploy. That platform's prod starts sending
--      the new key; OR's new hash matches; auth restored.
--   5. Total platform auth-fail window: redeploy duration (typically <2 min).

-- OR DEV (gposxxmxenrdvewrprle) does not have the `platforms` table — V2 only
-- talks to OR PROD, so the rotation is a no-op on DEV. Guard the UPDATE so
-- the migration is idempotent + safe to apply via Mgmt API on either project.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'platforms'
  ) THEN
    UPDATE public.platforms
    SET api_key_hash = '40c7758dc3e05a62922e8342b09edc01699097d92034d38000cc26a304923748',
        updated_at   = NOW()
    WHERE slug = 'bitbooks-v2';
  END IF;
END $$;
