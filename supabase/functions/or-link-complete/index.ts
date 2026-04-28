/**
 * or-link-complete — end of the /connect Link widget round trip.
 *
 * Called by the unauthenticated /connect widget after the end user has
 * pasted (for now) their provider API key. Provisions the subaccount
 * (idempotent), stores the encrypted credential, and creates a single
 * source_wallet stub so the integrating app gets a `source_wallet_id`
 * to persist on its end.
 *
 * THIS IS A THIN-SLICE ITERATION-1 ENTRY POINT.
 *
 *   - Auth: by-platform-slug (NOT X-Platform-API-Key). The widget runs
 *     in the end user's browser with no platform secret. Iteration 2
 *     will replace this with a short-lived widget session token issued
 *     server-to-server when the integrating app opens the widget URL.
 *
 *   - Encryption: the widget locks the API key with a key derived from
 *     a hardcoded test password ("LINK_WIDGET_TEST_PASSWORD" — see
 *     /connect route source). Iteration 2 will replace this with the
 *     real wallet-vault password the user picks at first setup.
 *
 *   - Wallet metadata: a single source_wallet row is created with the
 *     `external_wallet_id` the widget supplies (Blink's account-level
 *     wallet ID for now). Iteration 2 will run real wallet discovery
 *     and let the user pick which wallets to sync.
 *
 * POST body:
 *   platform_slug:                string  e.g. 'bitbooks-v2'
 *   app_user_id:                  string  the integrating app's user ID
 *   provider_type:                string  'blink' for now
 *   external_wallet_id:           string  opaque provider wallet ID
 *   encrypted_label:              string  base64 AES-256-GCM ciphertext
 *   encrypted_credentials:        string  base64 AES-256-GCM ciphertext
 *   encrypted_metadata:           string  base64 AES-256-GCM ciphertext (currency/label)
 *
 * Response 200:
 *   { subaccount_id, connection_id, source_wallet_id }
 *
 * Response 404 if platform_slug unknown; 400 on missing fields.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

const ALLOWED_PROVIDERS = new Set(['blink']);

interface LinkCompleteBody {
  platform_slug?: string;
  app_user_id?: string;
  provider_type?: string;
  external_wallet_id?: string;
  encrypted_label?: string;
  encrypted_credentials?: string;
  encrypted_metadata?: string;
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw || '{}') as LinkCompleteBody;

    if (!body.platform_slug || typeof body.platform_slug !== 'string') {
      return jsonResponse({ error: 'platform_slug required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    if (!body.provider_type || !ALLOWED_PROVIDERS.has(body.provider_type)) {
      return jsonResponse(
        { error: `provider_type must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}` },
        400, cors,
      );
    }
    if (!body.external_wallet_id || typeof body.external_wallet_id !== 'string') {
      return jsonResponse({ error: 'external_wallet_id required' }, 400, cors);
    }
    if (!body.encrypted_credentials || body.encrypted_credentials.length > 65536) {
      return jsonResponse({ error: 'encrypted_credentials required (base64, ≤64 KB)' }, 400, cors);
    }
    if (!body.encrypted_metadata || body.encrypted_metadata.length > 4096) {
      return jsonResponse({ error: 'encrypted_metadata required (base64, ≤4 KB)' }, 400, cors);
    }

    const serviceClient = makeServiceClient();

    // 1. Resolve platform by slug (NOT api key — see header note).
    const { data: platform, error: platErr } = await serviceClient
      .from('platforms')
      .select('id, slug')
      .eq('slug', body.platform_slug)
      .maybeSingle();
    if (platErr || !platform) {
      return jsonResponse({ error: 'Unknown platform' }, 404, cors);
    }

    // 2. Provision (or look up) the subaccount.
    let subaccountId: string;
    const { data: existingSub } = await serviceClient
      .from('subaccounts')
      .select('id')
      .eq('platform_id', platform.id)
      .eq('external_user_id', body.app_user_id)
      .maybeSingle();

    if (existingSub) {
      subaccountId = existingSub.id as string;
    } else {
      const { data: createdSub, error: insSubErr } = await serviceClient
        .from('subaccounts')
        .insert({ platform_id: platform.id, external_user_id: body.app_user_id })
        .select('id')
        .single();
      if (insSubErr || !createdSub) {
        console.error('[or-link-complete] subaccount insert failed:', insSubErr);
        return jsonResponse({ error: 'Failed to create subaccount' }, 500, cors);
      }
      subaccountId = createdSub.id as string;
    }

    // 3. Insert the encrypted connection.
    const { data: createdConn, error: insConnErr } = await serviceClient
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
    if (insConnErr || !createdConn) {
      console.error('[or-link-complete] connection insert failed:', insConnErr);
      return jsonResponse({ error: 'Failed to create connection' }, 500, cors);
    }
    const connectionId = createdConn.id as string;

    // 4. Insert one source_wallet stub (Bitwarden-hybrid: external_wallet_id
    //    plaintext for routing, encrypted_metadata opaque for currency/label).
    const { data: createdSw, error: insSwErr } = await serviceClient
      .from('source_wallets')
      .insert({
        connection_id: connectionId,
        external_wallet_id: body.external_wallet_id,
        is_synced: true,
        encrypted_metadata: body.encrypted_metadata,
        encrypted_metadata_key_version: 1,
      })
      .select('id')
      .single();
    if (insSwErr || !createdSw) {
      console.error('[or-link-complete] source_wallet insert failed:', insSwErr);
      return jsonResponse({ error: 'Failed to create source wallet' }, 500, cors);
    }

    return jsonResponse(
      {
        subaccount_id: subaccountId,
        connection_id: connectionId,
        source_wallet_id: createdSw.id as string,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error('[or-link-complete] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
