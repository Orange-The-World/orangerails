-- OR-T2787 B2: sync source_wallets.encrypted_metadata_key_version to match prod (NOT NULL DEFAULT 1)
-- Idempotent: no-op on prod (column already NOT NULL DEFAULT 1); fixes dev to match prod.
-- Drops dev-only pair constraint (approved by CTO, never on prod).
ALTER TABLE public.source_wallets
  DROP CONSTRAINT IF EXISTS source_wallets_encrypted_metadata_pair_ck;

UPDATE public.source_wallets
   SET encrypted_metadata_key_version = 1
 WHERE encrypted_metadata_key_version IS NULL;

ALTER TABLE public.source_wallets
  ALTER COLUMN encrypted_metadata_key_version SET DEFAULT 1;

ALTER TABLE public.source_wallets
  ALTER COLUMN encrypted_metadata_key_version SET NOT NULL;
