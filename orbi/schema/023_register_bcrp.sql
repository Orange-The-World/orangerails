-- ORBI migration 023 — register Banco Central de Reserva del Perú (BCRP) source.
--
-- Ships USD/PEN daily interbank reference rate ("Tipo de Cambio
-- Interbancario - Venta", BCRP series PD04638PD), pulled directly from
-- BCRPData REST API at
--   https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json/<from>/<to>
--
-- The BCRPData API is free, no-auth, no-key — open public data from the
-- estadisticas.bcrp.gob.pe subdomain (which is NOT behind the Incapsula
-- bot challenge that fronts www.bcrp.gob.pe). Silent-friendly under
-- ORBI's Hybrid Asymmetric Strategy.
--
-- Authority signature: BCRP per data origin; transport is the
-- BCRP-operated estadisticas subdomain, so authority == transport in
-- this case (no proxy intermediary like BCCH/mindicador).
--
-- Shipped ACTIVE: BCRPData has been stable since the early 2010s and
-- the URL pattern is documented in BCRP's "API para Desarrolladores"
-- help page (https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api).
--
-- Slot 023: this migration occupies the BCRP slot in the concurrent
-- Phase D.4 emerging-market FX expansion (slots 018=BNM, 019=BI,
-- 020=BANREP, 021=SARB or RBI, 022=reserve, 023=BCRP). The CHECK
-- constraint ARRAY below is comprehensive of all authority codes
-- shipped in ORBI through this point, so re-running this migration
-- after the intermediate slots have landed is idempotent.

-- ----------------------------------------------------------------------------
-- Extend source_authority CHECK constraint to allow 'BCRP'.
--
-- The constraint was originally defined in migration 006 as a closed
-- list and has been DROP/ADD'd by each subsequent authority migration
-- (011 → 016 → 017). We re-issue the full list here including BCRP so
-- this migration is self-sufficient when applied after any combination
-- of its concurrent siblings.
-- ----------------------------------------------------------------------------

ALTER TABLE exchange_rates
  DROP CONSTRAINT IF EXISTS exchange_rates_source_authority_check;

ALTER TABLE exchange_rates
  ADD CONSTRAINT exchange_rates_source_authority_check
  CHECK (source_authority = ANY (ARRAY[
    'ORBI'::text,
    'ECB'::text,
    'BANXICO'::text,
    'BCB'::text,
    'BOC'::text,
    'FED'::text,
    'BOE'::text,
    'RBA'::text,
    'SNB'::text,
    'BOJ'::text,
    'BCCH'::text,
    'BLOCKCHAIN_COM'::text,
    'BSP'::text,
    'BCRP'::text
  ]));

-- ----------------------------------------------------------------------------
-- Register BCRP provider row.
-- ----------------------------------------------------------------------------

INSERT INTO exchange_rate_providers
  (name, role, active, endpoint_base, user_agent, rate_limit_rps, pairs_supported, permission_status, notes)
VALUES
  ('bcrp', 'primary', TRUE,
   'https://estadisticas.bcrp.gob.pe/estadisticas/series/api',
   'Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)',
   0.5,
   '["USD-PEN"]'::jsonb,
   'free-public',
   'Banco Central de Reserva del Perú daily USD/PEN interbank reference rate ("Tipo de Cambio Interbancario - Venta", series PD04638PD). Sourced directly from BCRPData REST API (estadisticas.bcrp.gob.pe), free no-auth no-key open public data. Authority signature BCRP per data origin; same domain operates the API so no proxy intermediary. Coverage 2003-01-02 onward, business days only.'
  )
ON CONFLICT (name) DO NOTHING;
