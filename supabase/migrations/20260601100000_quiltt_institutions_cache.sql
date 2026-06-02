-- quiltt_institutions_cache — server-side cache of Quiltt's institution
-- catalog so V2/OW/etc. can render bank tiles in their picker WITHOUT
-- a per-user Quiltt session.
--
-- Refreshed by the or-institutions-catalog edge function (24h TTL).
-- Public read; service-role write only.

CREATE TABLE IF NOT EXISTS public.quiltt_institutions_cache (
  -- Quiltt connector id this catalog belongs to (one connector = one
  -- catalog because providers + brand vary per connector). Cached
  -- per-connector so multi-tenant integrators sharing OR don't poison
  -- each other's catalogs.
  connector_id TEXT NOT NULL,
  -- Quiltt institution id (stable across runs)
  institution_id TEXT NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  -- Lower-cased name for fast prefix/substring filtering in clients.
  searchable TEXT NOT NULL,
  -- Original Quiltt payload — kept so future fields (verified, kind,
  -- providers[]) don't require a schema migration.
  raw JSONB,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, institution_id)
);

-- For prefix searches as the user types: "fin" → indexed lookup.
CREATE INDEX IF NOT EXISTS quiltt_institutions_cache_searchable_idx
  ON public.quiltt_institutions_cache (connector_id, searchable text_pattern_ops);

-- Whole-catalog age. or-institutions-catalog reads MIN(refreshed_at)
-- to decide whether to refresh. Per-row refreshed_at lets us partially
-- update if Quiltt's paginated response splits across multiple calls.
CREATE INDEX IF NOT EXISTS quiltt_institutions_cache_refreshed_idx
  ON public.quiltt_institutions_cache (connector_id, refreshed_at);

-- Public read — institution names are not PII or sensitive.
ALTER TABLE public.quiltt_institutions_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY quiltt_institutions_cache_public_read
  ON public.quiltt_institutions_cache
  FOR SELECT
  USING (true);
-- No insert/update/delete policy → only service-role can write.
