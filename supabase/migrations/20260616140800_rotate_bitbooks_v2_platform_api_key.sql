-- Rotate the bitbooks-v2 platform API key.
--
-- Why: the raw key minted at platform-registration time (migration
-- 20260424120000) lived only on a contributor's Vercel and was never recorded in
-- our Proton Pass vault. The api.orangerails.com Canonical Gateway project
-- (2026-06-16) surfaced the gap. Rotating to a freshly-generated key that
-- both sides record in their canonical secret stores closes the audit gap.
--
-- The new raw key was generated on maintainer infrastructure 2026-06-16 by
-- /tmp/rotate-v2-or-key.sh — 32 random bytes hex-encoded. Stored in
-- Proton Pass vault "10 AI AGENT - JARVIS" as V2_OR_PLATFORM_API_KEY and
-- shared with a contributor via the same channel for him to put on Vercel.
--
-- Cutover plan (coordinated to minimise prod auth window):
--   1. a contributor updates Vercel OR_PLATFORM_API_KEY to the new value on all
--      three scopes (Production, Preview, Development) and stages a
--      redeploy.
--   2. a contributor confirms ready.
--   3. THIS migration is merged to OR prod (CI applies via Mgmt API).
--   4. a contributor triggers the Vercel redeploy. V2 prod starts sending the
--      new key; OR's new hash matches; auth restored.
--   5. Total V2 prod auth-fail window: redeploy duration (typically <2 min).

UPDATE public.platforms
SET api_key_hash = '40c7758dc3e05a62922e8342b09edc01699097d92034d38000cc26a304923748',
    updated_at   = NOW()
WHERE slug = 'bitbooks-v2';
