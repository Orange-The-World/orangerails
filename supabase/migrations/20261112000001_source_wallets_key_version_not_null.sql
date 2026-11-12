-- OR-T2787 B2: source_wallets.encrypted_metadata_key_version is NOT NULL DEFAULT 1 on prod.
-- Bring dev to match. Idempotent; a no-op on prod (constraint absent, no NULL rows,
-- default and NOT NULL already set).
ALTER TABLE public.source_wallets
  DROP CONSTRAINT IF EXISTS source_wallets_encrypted_metadata_pair_ck;

UPDATE public.source_wallets
   SET encrypted_metadata_key_version = 1
 WHERE encrypted_metadata_key_version IS NULL;

ALTER TABLE public.source_wallets
  ALTER COLUMN encrypted_metadata_key_version SET DEFAULT 1;

ALTER TABLE public.source_wallets
  ALTER COLUMN encrypted_metadata_key_version SET NOT NULL;
