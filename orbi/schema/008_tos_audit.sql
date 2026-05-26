-- ORBI Phase D.2 — Terms-of-Service audit trail
--
-- Why this exists: ORBI ingests rates from ~16 third-party sources (crypto
-- exchanges, central banks, FX aggregators). Each source has its own Terms
-- of Service. The ToS occasionally change. When ORBI is challenged or
-- audited — by a regulator, by a source itself, or by a customer who is
-- relying on our output — we must be able to prove what each source's ToS
-- said at the moment we ingested data, and what our usage assessment was
-- at that moment.
--
-- This table is the audit-grade evidence trail. One row per (source,
-- fetched_at). Newer rows mark older rows as `superseded_at` when content
-- changes (detected by sha256 mismatch). Nothing is ever deleted.
--
-- See orbi/scripts/tos-compliance/fetch-and-archive.ts for the writer
-- and orbi/scripts/tos-compliance/sources.json for the manifest of
-- source_key → ToS URL.

CREATE TABLE IF NOT EXISTS source_terms_of_service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  tos_url text NOT NULL,
  tos_sha256 text NOT NULL,
  archived_text text NOT NULL,
  archive_format text NOT NULL DEFAULT 'html'
    CHECK (archive_format IN ('html', 'text', 'pdf-text')),
  our_usage_assessment text NOT NULL
    CHECK (our_usage_assessment IN (
      'permitted',
      'permitted-with-attribution',
      'permitted-non-commercial',
      'requires-written-approval',
      'prohibited',
      'ambiguous'
    )),
  assessment_notes text,
  assessed_by text NOT NULL DEFAULT 'agent'
    CHECK (assessed_by IN ('agent', 'founder', 'legal-counsel')),
  superseded_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_tos_source_key_idx
  ON source_terms_of_service (source_key, fetched_at DESC);

-- Partial index: lets queries for "current ToS for source X" hit one row
-- in O(1) without scanning superseded history.
CREATE INDEX IF NOT EXISTS source_tos_current_idx
  ON source_terms_of_service (source_key)
  WHERE superseded_at IS NULL;

COMMENT ON TABLE source_terms_of_service IS
  'Time-versioned archive of each data source''s Terms of Service. Mandatory for ORBI''s audit-grade compliance — when challenged, we can prove what the ToS said at the moment we ingested the data.';

COMMENT ON COLUMN source_terms_of_service.source_key IS
  'Matches exchange_rate_providers.provider_key for exchange sources, or a canonical key for non-exchange sources (banxico, bcb, boc, boe, frankfurter, mempool.space, etc.).';

COMMENT ON COLUMN source_terms_of_service.tos_sha256 IS
  'Hex SHA-256 of archived_text. Used to detect ToS changes between fetches.';

COMMENT ON COLUMN source_terms_of_service.superseded_at IS
  'NULL while this row represents the current ToS for the source. Set to the fetched_at of a newer row when that row''s sha256 differs.';
