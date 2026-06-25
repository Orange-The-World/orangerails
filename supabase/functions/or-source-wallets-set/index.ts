/**
 * or-source-wallets-set , upsert the user's source-wallet selection for a connection.
 *
 * Receives the wallet selection from the client (which has already encrypted
 * each wallet's metadata with ORK in the browser) and stores it. Subsequent
 * or-sync calls filter on `is_synced` and pass the plaintext
 * `external_wallet_id` list to the provider adapter.
 *
 * Auth: same dual-mode as or-sync (X-Platform-API-Key OR Supabase JWT).
 *
 * POST body:
 *   subaccount_id?:  uuid    required in platform mode
 *   connection_id:   uuid    the connection to update
 *   source_wallets:  Array<{
 *     external_wallet_id: string,           // opaque provider ID, plaintext
 *     encrypted_metadata: string,           // base64 AES-256-GCM (ORK-encrypted JSON)
 *     is_synced: boolean,
 *   }>
 *
 * Response:
 *   { source_wallets: [{ id, external_wallet_id, is_synced, encrypted_metadata }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface InboundWallet {
  external_wallet_id: string;
  encrypted_metadata: string;
  is_synced: boolean;
}

const MAX_WALLETS_PER_CONNECTION = 50; // sanity cap; Blink today has 2 (BTC + USD)
const MAX_ENCRYPTED_METADATA_LEN = 8192; // ~8 KB ciphertext per wallet

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
      connection_id?: string;
      source_wallets?: InboundWallet[];
    };

    if (!body.connection_id || typeof body.connection_id !== 'string') {
      return jsonResponse({ error: 'connection_id required' }, 400, cors);
    }
    if (!Array.isArray(body.source_wallets)) {
      return jsonResponse({ error: 'source_wallets must be an array' }, 400, cors);
    }
    if (body.source_wallets.length > MAX_WALLETS_PER_CONNECTION) {
      return jsonResponse(
        { error: `Too many wallets (max ${MAX_WALLETS_PER_CONNECTION})` },
        413, cors,
      );
    }

    // Validate each wallet entry shape before any DB write.
    for (const w of body.source_wallets) {
      if (!w || typeof w !== 'object') {
        return jsonResponse({ error: 'Each source_wallet must be an object' }, 400, cors);
      }
      if (!w.external_wallet_id || typeof w.external_wallet_id !== 'string') {
        return jsonResponse({ error: 'external_wallet_id required on each wallet' }, 400, cors);
      }
      if (!w.encrypted_metadata || typeof w.encrypted_metadata !== 'string') {
        return jsonResponse({ error: 'encrypted_metadata required on each wallet' }, 400, cors);
      }
      if (w.encrypted_metadata.length > MAX_ENCRYPTED_METADATA_LEN) {
        return jsonResponse({ error: 'encrypted_metadata too large' }, 413, cors);
      }
      if (typeof w.is_synced !== 'boolean') {
        return jsonResponse({ error: 'is_synced must be a boolean on each wallet' }, 400, cors);
      }
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    // Verify caller owns the connection.
    const { data: conn, error: connErr } = await ctx.serviceClient
      .from('connections')
      .select('id')
      .eq('id', body.connection_id)
      .eq('subaccount_id', subaccountId)
      .maybeSingle();

    if (connErr) {
      console.error('[or-source-wallets-set] connection lookup failed:', connErr);
      return jsonResponse({ error: 'Connection lookup failed' }, 500, cors);
    }
    if (!conn) return jsonResponse({ error: 'Connection not found' }, 404, cors);

    // Upsert each wallet. ON CONFLICT (connection_id, external_wallet_id)
    // means a re-call with the same wallet replaces is_synced + ciphertext ,
    // perfect for "user reopened picker, toggled USD off" flows.
    const rows = body.source_wallets.map(w => ({
      connection_id: body.connection_id!,
      external_wallet_id: w.external_wallet_id,
      is_synced: w.is_synced,
      encrypted_metadata: w.encrypted_metadata,
      encrypted_metadata_key_version: 1,
    }));

    const { data: upserted, error: upsertErr } = await ctx.serviceClient
      .from('source_wallets')
      .upsert(rows, { onConflict: 'connection_id,external_wallet_id' })
      .select('id, external_wallet_id, is_synced, encrypted_metadata');

    if (upsertErr) {
      console.error('[or-source-wallets-set] upsert failed:', upsertErr);
      return jsonResponse({ error: 'Failed to save source wallets' }, 500, cors);
    }

    return jsonResponse({ source_wallets: upserted ?? [] }, 200, cors);
  } catch (err) {
    console.error('[or-source-wallets-set] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-source-wallets-set'));
