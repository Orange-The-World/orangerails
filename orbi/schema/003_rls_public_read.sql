-- ORBI Phase 1 — Row-Level Security for consumer reads
-- Enables V3, Orange Way Personal (OWM), Orange Way Books (OWB), Koinly partners,
-- and any future Tier-3 commercial customers to read published rates via the
-- Supabase anon key — without ever getting write access.
--
-- The write path remains the forward-fill cron (using service-role credentials)
-- and the on-demand Edge Function (also service-role). Anything authenticated
-- as anon (or non-service-role authenticated user) can SELECT only.

-- Enable RLS on the three ORBI tables
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate_providers ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- exchange_rates — public read of CONFIRMED rates only
-- ============================================================
-- PENDING and CORRECTED rows are filtered out to prevent consumers from seeing
-- transient states. Service-role writes bypass RLS by default.

DROP POLICY IF EXISTS "Public read access to confirmed rates" ON exchange_rates;
CREATE POLICY "Public read access to confirmed rates"
  ON exchange_rates
  FOR SELECT
  TO anon, authenticated
  USING (status = 'CONFIRMED');

-- ============================================================
-- exchange_rate_resolutions — public read for audit transparency
-- ============================================================
-- The audit log is the public-goods promise: anyone can verify any published
-- rate by querying its resolution row and re-running vwMedian on the stored
-- input candles. Required for the open-methodology positioning.

DROP POLICY IF EXISTS "Public read access to audit log" ON exchange_rate_resolutions;
CREATE POLICY "Public read access to audit log"
  ON exchange_rate_resolutions
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ============================================================
-- exchange_rate_providers — public read of provider registry
-- ============================================================
-- The provider list is operational metadata, not sensitive. Allows consumers
-- to see which sources are active and what their permission_status is —
-- supports the public incident log story.

DROP POLICY IF EXISTS "Public read access to provider registry" ON exchange_rate_providers;
CREATE POLICY "Public read access to provider registry"
  ON exchange_rate_providers
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ============================================================
-- No INSERT / UPDATE / DELETE policies created for anon/authenticated.
-- Without a policy, those operations are BLOCKED. Service-role bypasses RLS
-- and is the only path that can write.
-- ============================================================

COMMENT ON POLICY "Public read access to confirmed rates" ON exchange_rates IS
  'Pattern A integration: V3, OWM, OWB, and future Tier-3 partners read CONFIRMED rates with the OR PROD anon key. PENDING/CORRECTED rates are hidden until the forward-fill resolves them.';

COMMENT ON POLICY "Public read access to audit log" ON exchange_rate_resolutions IS
  'Anyone can verify any published ORBI rate by joining to this audit row and re-running vwMedian on the stored input candles. This is the public-goods commitment in the methodology.';
