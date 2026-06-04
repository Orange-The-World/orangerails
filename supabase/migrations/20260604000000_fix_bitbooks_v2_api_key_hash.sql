-- Fix bitbooks-v2 platform api_key_hash to match V2dev's actual key.
-- The hash drifted when OR_BASE_URL was repointed during local-OR setup.
-- hash prefix: faa81c1225cb
UPDATE public.platforms
SET api_key_hash = 'faa81c1225cbba81a59e38a8a9df96a362683eac9f7d451da482768e3fa8bb1f',
    updated_at = now()
WHERE slug = 'bitbooks-v2';
