/**
 * or-connection-create , store an encrypted connection for a subaccount.
 *
 * The platform's browser already encrypted the credential and label with
 * the user's ORK before calling. OR stores ciphertext only; cannot decrypt.
 *
 * Auth: same modes as or-sync (platform via X-Platform-API-Key, direct via JWT).
 *
 * POST body:
 *   subaccount_id?:        uuid    required in platform mode
 *   provider_type:         string  any registered provider slug , see
 *                                   _shared/providers/dispatch.ts
 *   encrypted_label:       string  base64 AES-256-GCM (ORK-encrypted)
 *   encrypted_credentials: string  base64 AES-256-GCM (ORK-encrypted)
 *
 * Response:
 *   { connection_id: uuid }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { getProvider, listProviderSlugs } from '../_shared/providers/dispatch.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as {
      subaccount_id?: string;
      provider_type?: string;
      encrypted_label?: string;
      encrypted_credentials?: string;
    };

    if (!body.provider_type || !getProvider(body.provider_type)) {
      return jsonResponse(
        { error: `provider_type must be one of: ${listProviderSlugs().join(', ')}` },
        400, cors,
      );
    }
    if (!body.encrypted_credentials || typeof body.encrypted_credentials !== 'string') {
      return jsonResponse({ error: 'encrypted_credentials required (base64 string)' }, 400, cors);
    }
    // Cap ciphertext size to prevent abuse (~64 KB is plenty for an API key).
    if (body.encrypted_credentials.length > 65536 || (body.encrypted_label?.length ?? 0) > 4096) {
      return jsonResponse({ error: 'encrypted payload too large' }, 413, cors);
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const { data: created, error: insErr } = await ctx.serviceClient
      .from('connections')
      .insert({
        subaccount_id: subaccountId,
        provider_type: body.provider_type,
        encrypted_label: body.encrypted_label ?? null,
        encrypted_credentials: body.encrypted_credentials,
        credentials_key_version: 1,
        status: 'active',
      })
      .select('id')
      .single();

    if (insErr || !created) {
      console.error('[or-connection-create] insert failed:', insErr);
      return jsonResponse({ error: 'Failed to create connection' }, 500, cors);
    }

    return jsonResponse({ connection_id: created.id as string }, 200, cors);
  } catch (err) {
    console.error('[or-connection-create] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-connection-create'));
