-- Add BUDA to the exchange_rates source_authority allowlist.
--
-- Why: BUDA (buda.com) is an active crypto exchange feeding BTC/CLP, BTC/COP,
-- BTC/PEN pairs. It was missing from the CHECK constraint introduced in
-- migration 20260730120001, which meant any BUDA insert after that migration
-- was rejected with a CHECK violation. Pre-July-30 rows survive (constraint
-- was not retroactive) but no new rows have landed since.
--
-- This migration drops the existing constraint and recreates it with BUDA
-- included. The change is additive: no existing rows are invalidated.

alter table public.exchange_rates
  drop constraint exchange_rates_source_authority_check;

alter table public.exchange_rates
  add constraint exchange_rates_source_authority_check check (
    source_authority = any (array[
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
      'BCRP'::text,
      'BNM'::text,
      'BI'::text,
      'BANREP'::text,
      'SARB'::text,
      'RBI'::text,
      'BITSTAMP'::text,
      'KRAKEN'::text,
      'COINBASE_EXCHANGE'::text,
      'BITFINEX'::text,
      'BITSO'::text,
      'MERCADO_BITCOIN'::text,
      'BITBANK'::text,
      'COINCHECK'::text,
      'MEMPOOL_SPACE'::text,
      'BUDA'::text
    ])
  );
