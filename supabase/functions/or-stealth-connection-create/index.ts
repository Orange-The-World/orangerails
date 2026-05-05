/**
 * or-stealth-connection-create — insert a sealed envelope.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * The widget popup calls this from the user's browser after producing a
 * SealedEnvelope (see src/stealth/lib/postmessage.ts). OR stores the
 * ciphertext as opaque bytes; OR cannot decrypt.
 *
 * Auth pattern reused from or-connection-create: platform-mode (X-Platform-API-Key)
 * or direct-mode (Supabase JWT). See _shared/platform-auth.ts.
 *
 * POST body:
 *   app_slug:                  string                     'v2' | 'v3' | 'ow' | <third-party>
 *   app_user_id:               string (uuid)              opaque routing key
 *   connection_kind:           'xpub_stealth' | 'descriptor_stealth'
 *   sealed_envelope:           SealedEnvelope             jsonb
 *   blind_index:               string (hex)               OPTIONAL HMAC of the normalized input
 *   wallet_birthday_plaintext: string (ISO date)          OPTIONAL
 *
 * Response:
 *   { connection_id: uuid }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

interface CreateRequestBody {
  app_slug?: string;
  app_user_id?: string;
  connection_kind?: 'xpub_stealth' | 'descriptor_stealth';
  sealed_envelope?: unknown;
  blind_index?: string;
  wallet_birthday_plaintext?: string | null;
}

interface CreateResponseBody {
  connection_id: string;
}

interface SealedEnvelopeShape {
  version: number;
  algorithm: string;
  iv_b64: string;
  ciphertext_b64: string;
}

function isSealedEnvelope(x: unknown): x is SealedEnvelopeShape {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.algorithm === 'string' &&
    typeof o.iv_b64 === 'string' &&
    typeof o.ciphertext_b64 === 'string'
  );
}

// Cap envelope JSON size. xpub envelopes are tiny; multisig descriptors top
// out around a few KB. 64 KB is generous and prevents abuse.
const MAX_ENVELOPE_BYTES = 65_536;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as CreateRequestBody;

    // ── Validate ──────────────────────────────────────────────────────
    if (!body.app_slug || typeof body.app_slug !== 'string') {
      return jsonResponse({ error: 'app_slug required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }
    if (
      body.connection_kind !== 'xpub_stealth' &&
      body.connection_kind !== 'descriptor_stealth'
    ) {
      return jsonResponse(
        { error: "connection_kind must be 'xpub_stealth' or 'descriptor_stealth'" },
        400, cors,
      );
    }
    if (!isSealedEnvelope(body.sealed_envelope)) {
      return jsonResponse({ error: 'sealed_envelope is malformed' }, 400, cors);
    }
    const envSize = JSON.stringify(body.sealed_envelope).length;
    if (envSize > MAX_ENVELOPE_BYTES) {
      return jsonResponse({ error: 'sealed_envelope too large' }, 413, cors);
    }
    if (
      body.wallet_birthday_plaintext !== null &&
      body.wallet_birthday_plaintext !== undefined &&
      !ISO_DATE_RE.test(body.wallet_birthday_plaintext)
    ) {
      return jsonResponse(
        { error: 'wallet_birthday_plaintext must be an ISO date (YYYY-MM-DD) or null' },
        400, cors,
      );
    }

    // In direct mode, lock app_user_id to the authenticated user. The widget
    // is a direct-mode caller (it has the user's Supabase JWT from the
    // consuming app's session). Platform mode is reserved for server-to-server
    // integrations and will pass app_user_id explicitly.
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    const { data: created, error: insErr } = await ctx.serviceClient
      .from('stealth_connections')
      .insert({
        app_user_id: body.app_user_id,
        app_slug: body.app_slug,
        connection_kind: body.connection_kind,
        sealed_envelope: body.sealed_envelope,
        wallet_birthday_plaintext: body.wallet_birthday_plaintext ?? null,
        status: 'active',
      })
      .select('id')
      .single();

    if (insErr || !created) {
      console.error('[or-stealth-connection-create] insert failed:', insErr);
      return jsonResponse({ error: 'Failed to create stealth connection' }, 500, cors);
    }

    const resp: CreateResponseBody = { connection_id: created.id as string };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-connection-create] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type { CreateRequestBody, CreateResponseBody };
