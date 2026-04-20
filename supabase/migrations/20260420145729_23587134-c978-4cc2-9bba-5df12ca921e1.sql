-- Step 1 — PQC key material per user on user_vault_meta.
ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS kem_public_key     TEXT,
  ADD COLUMN IF NOT EXISTS kem_secret_wrapped TEXT,
  ADD COLUMN IF NOT EXISTS sig_public_key     TEXT,
  ADD COLUMN IF NOT EXISTS sig_secret_wrapped TEXT,
  ADD COLUMN IF NOT EXISTS pqc_key_version    INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.user_vault_meta.kem_public_key IS
  'Base64 of concat(x25519_pub, ml_kem768_pub). 1216 bytes raw. Plaintext is safe — it is a public key.';

COMMENT ON COLUMN public.user_vault_meta.kem_secret_wrapped IS
  'AES-256-GCM ciphertext (MEK-derived subkey) of concat(x25519_sec, ml_kem768_sec). 2432 bytes raw before encryption. Base64 after.';

COMMENT ON COLUMN public.user_vault_meta.sig_public_key IS
  'Base64 of the ML-DSA-65 public key. 1952 bytes raw.';

COMMENT ON COLUMN public.user_vault_meta.sig_secret_wrapped IS
  'AES-256-GCM ciphertext (MEK-derived subkey) of the ML-DSA-65 secret key. 4032 bytes raw before encryption. Base64 after.';

COMMENT ON COLUMN public.user_vault_meta.pqc_key_version IS
  'Version of the PQC algorithm suite in use. 1 = hybrid-x25519-mlkem768 + ml-dsa-65. Bumped in coordinated migrations when algorithms upgrade.';

-- Step 2 — per-recipient wrapped data keys.
CREATE TABLE IF NOT EXISTS public.wrapped_data_keys (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  data_key_id        UUID         NOT NULL,
  recipient_user_id  UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_ciphertext TEXT         NOT NULL,
  algorithm          TEXT         NOT NULL DEFAULT 'hybrid-x25519-mlkem768',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wrapped_data_keys IS
  'One row per (data_key_id, recipient_user_id). wrapped_ciphertext is base64 of the opaque blob produced by KEY_WRAP_STRATEGIES[algorithm] in src/lib/key-wrapping.ts.';

COMMENT ON COLUMN public.wrapped_data_keys.algorithm IS
  'Key-wrap strategy identifier. Must match a key in KEY_WRAP_STRATEGIES; defaults to hybrid-x25519-mlkem768 (X25519 + ML-KEM-768, HKDF-SHA-256 combiner).';

CREATE INDEX IF NOT EXISTS wrapped_data_keys_data_key_id_idx
  ON public.wrapped_data_keys(data_key_id);

CREATE INDEX IF NOT EXISTS wrapped_data_keys_recipient_user_id_idx
  ON public.wrapped_data_keys(recipient_user_id);

-- Step 3 — RLS: recipients can read their own rows.
ALTER TABLE public.wrapped_data_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Recipients can read their own wrapped data keys" ON public.wrapped_data_keys;
CREATE POLICY "Recipients can read their own wrapped data keys"
  ON public.wrapped_data_keys
  FOR SELECT
  USING (recipient_user_id = auth.uid());