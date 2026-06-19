/**
 * or-provision , create or look up a subaccount.
 *
 * Platform mode (X-Platform-API-Key): create/find a subaccount under
 *   the calling platform with body.external_user_id. Idempotent:
 *   returns the existing subaccount_id if one already exists for this
 *   (platform_id, external_user_id) pair.
 *
 * Direct mode (Supabase JWT): no-op except returning the user's own
 *   direct subaccount_id (already auto-resolved by authenticateRequest).
 *   Body's external_user_id is ignored to prevent self-impersonation.
 *
 * POST body:
 *   external_user_id: string  required in platform mode
 *
 * Response:
 *   { subaccount_id: uuid, created: boolean }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    if (ctx.mode === 'direct') {
      // Direct mode: subaccount already auto-resolved at auth time.
      return jsonResponse({ subaccount_id: ctx.subaccountId, created: false }, 200, cors);
    }

    // Platform mode: provision under the calling platform.
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw || '{}') as { external_user_id?: string };
    const externalUserId = body.external_user_id;
    if (!externalUserId || typeof externalUserId !== 'string' || externalUserId.length > 256) {
      return jsonResponse({ error: 'external_user_id required (string, ≤256 chars)' }, 400, cors);
    }

    // Try to find an existing subaccount for this (platform, external_user_id).
    const { data: existing } = await ctx.serviceClient
      .from('subaccounts')
      .select('id')
      .eq('platform_id', ctx.platformId)
      .eq('external_user_id', externalUserId)
      .maybeSingle();

    if (existing) {
      return jsonResponse({ subaccount_id: existing.id as string, created: false }, 200, cors);
    }

    const { data: created, error: insErr } = await ctx.serviceClient
      .from('subaccounts')
      .insert({ platform_id: ctx.platformId, external_user_id: externalUserId })
      .select('id')
      .single();

    if (insErr || !created) {
      console.error('[or-provision] insert failed:', insErr);
      return jsonResponse({ error: 'Failed to create subaccount' }, 500, cors);
    }

    return jsonResponse({ subaccount_id: created.id as string, created: true }, 200, cors);
  } catch (err) {
    console.error('[or-provision] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
