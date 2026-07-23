-- Remove the unused discovery_source column from public.source_wallets.
--
-- Present on the dev database only (manual-apply drift), absent on prod.
-- No reader in the repository and no row carries a value, so the drop is
-- data-lossless and closes the dev/prod schema gap.
--
-- Idempotent: IF EXISTS makes this a no-op where the column is already gone.
-- Reversal: ALTER TABLE public.source_wallets ADD COLUMN IF NOT EXISTS discovery_source text;

ALTER TABLE public.source_wallets
  DROP COLUMN IF EXISTS discovery_source;
