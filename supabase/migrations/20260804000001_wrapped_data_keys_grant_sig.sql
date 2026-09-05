-- DL-0619: ML-DSA-65 grant signature column on wrapped_data_keys
--
-- The co-admin grant flow (grantCoAdmin in src/lib/co-admin.ts) now signs
-- the grant binding with the owner's ML-DSA-65 secret key and stores the
-- signature here. The consume flow (loadAdminSubkeysDirect) verifies the
-- signature before any decryption; missing or invalid signature is a hard
-- reject (fail-closed).
--
-- Signed payload: JSON.stringify({
--   ctx: "orangerails:add-member:mek-wrap:v1",
--   granteeUserId,
--   workspaceKeyId,
--   wrappedCt,   -- base64 of wrapped_ciphertext
-- })
--
-- Safe: DBA verified wrapped_data_keys has 0 rows on dev and prod
-- (2026-08-04), so NOT NULL with no default is safe.

ALTER TABLE public.wrapped_data_keys
  ADD COLUMN IF NOT EXISTS grant_sig TEXT NOT NULL;

COMMENT ON COLUMN public.wrapped_data_keys.grant_sig IS
  'ML-DSA-65 signature (base64) produced by the owner at grant time over '
  'JSON({ctx, granteeUserId, workspaceKeyId, wrappedCt}). The co-admin '
  'consume path verifies this before decrypting. Missing or invalid = hard reject.';
