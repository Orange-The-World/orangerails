/**
 * or-stealth-connection-create — insert a sealed envelope.
 *
 * Milestone 1 stub. Full behavior lives in STEALTH-SYNC-MASTER-PLAN.md §6.1.
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
  wallet_birthday_plaintext?: string | null;
}

interface CreateResponseBody {
  connection_id: string;
}

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

    // TODO(milestone-1): validate body fields, write row, return connection_id.
    // Schema lives in supabase/migrations/20260504000000_stealth_sync.sql.
    // See or-connection-create/index.ts for the existing insert+select pattern.
    void body;
    void ctx;

    return jsonResponse(
      { error: 'or-stealth-connection-create not yet implemented' },
      501,
      cors,
    );
  } catch (err) {
    console.error('[or-stealth-connection-create] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

// Re-exported for type-only consumers (tests, integration helpers).
export type { CreateRequestBody, CreateResponseBody };
