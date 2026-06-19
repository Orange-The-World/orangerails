-- Fix bitbooks-v2 platform api_key_hash — strip .env quotes from key before hashing.
-- V2's Next.js dotenv strips quotes; the hash must match the unquoted value.
UPDATE public.platforms
SET api_key_hash = 'a062878b4b05082f3f934f1879e76b9a3a21c58079ec48ed44e38035a8ce4dc3',
    updated_at = now()
WHERE slug = 'bitbooks-v2';
