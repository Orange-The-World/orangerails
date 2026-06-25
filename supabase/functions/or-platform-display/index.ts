/**
 * or-platform-display , public lookup for the /connect Link widget.
 *
 * Returns a minimal, non-sensitive subset of platform metadata so the
 * Link widget can render Plaid-hybrid co-branding (the integrating
 * app's name on top, "Powered by Orange Rails" smaller below) before
 * the user has authenticated.
 *
 * No auth required , only the slug is accepted, only display fields are
 * returned. The api_key_hash, tier, and is_internal columns are never
 * exposed by this function.
 *
 * GET / POST body: { slug: string }
 *
 * Response 200: { slug, display_name, display_brand_color }
 * Response 404: { error: 'Unknown platform' }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildPublicCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildPublicCorsHeaders();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    let slug: string | null = null;
    if (req.method === 'GET') {
      const url = new URL(req.url);
      slug = url.searchParams.get('slug');
    } else {
      const raw = await readBoundedText(req);
      if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
      const body = JSON.parse(raw || '{}') as { slug?: string };
      slug = body.slug ?? null;
    }

    if (!slug || typeof slug !== 'string' || slug.length > 64) {
      return jsonResponse({ error: 'slug required (string, ≤64 chars)' }, 400, cors);
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: platform, error } = await serviceClient
      .from('platforms')
      .select('slug, display_name, display_brand_color, name')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !platform) {
      return jsonResponse({ error: 'Unknown platform' }, 404, cors);
    }

    return jsonResponse(
      {
        slug: platform.slug as string,
        display_name: (platform.display_name as string | null) ?? (platform.name as string),
        display_brand_color: (platform.display_brand_color as string | null) ?? null,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error('[or-platform-display] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-platform-display'));
