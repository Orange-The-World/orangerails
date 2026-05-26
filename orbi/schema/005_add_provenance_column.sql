-- ORBI Phase B.1 — provenance tracking on exchange_rates
--
-- Adds a tag identifying which pipeline produced each rate row. Lets us
-- answer "where did this rate come from?" and roll back a specific backfill
-- without touching any forward-fill / reconciler output.
--
-- Values:
--   'forward-fill'         — live 1-min cron (default, current behavior)
--   'historical-backfill'  — bulk import from a historical source (Phase B.1+)
--   'reconciler-upgrade'   — gap reconciler tier upgrade (Phase A.5)
--   'composite-replay'     — future re-resolve via cross-rate (Phase B.5)

ALTER TABLE exchange_rates
  ADD COLUMN provenance text NOT NULL DEFAULT 'forward-fill'
  CHECK (provenance IN ('forward-fill', 'historical-backfill', 'reconciler-upgrade', 'composite-replay'));

CREATE INDEX exchange_rates_provenance_idx ON exchange_rates (provenance);

COMMENT ON COLUMN exchange_rates.provenance IS
  'Which pipeline produced this row. Lets us scope rollbacks (e.g. DELETE WHERE provenance=''historical-backfill'') without touching live forward-fill output.';
