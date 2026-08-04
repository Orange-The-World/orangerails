-- DL-0619: Add ML-DSA-65 grant signature columns to wrapped_data_keys.
--
-- Rows written before this migration have NULL in these columns.
-- The application (co-admin.ts:loadAdminSubkeysDirect) rejects grants where
-- grant_signature is NULL so the system fails closed. Owners must revoke and
-- re-issue any existing co-admin grants after this migration lands.

ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS grant_signature   TEXT,
  ADD COLUMN IF NOT EXISTS grant_sig_alg     TEXT,
  ADD COLUMN IF NOT EXISTS owner_sig_pub_key TEXT;

COMMENT ON COLUMN public.wrapped_data_keys.grant_signature IS
  'ML-DSA-65 signature (base64) over wrapped_ciphertext, produced by the owner at grant time. NULL means unsigned (pre-DL-0619) grant -- rejected on read.';
COMMENT ON COLUMN public.wrapped_data_keys.grant_sig_alg IS
  'Algorithm identifier for grant_signature (e.g. ''ml-dsa-65''). NULL if unsigned.';
COMMENT ON COLUMN public.wrapped_data_keys.owner_sig_pub_key IS
  'Owner ML-DSA-65 public key (base64) at time of grant, used to verify grant_signature on read. NULL if unsigned.';
