/**
 * or-connection-list — list a subaccount's connections.
 *
 * Returns encrypted blobs as-is. The caller's browser decrypts with ORK.
 *
 * Each connection also includes its source_wallets (if any) so the UI can
 * render per-wallet badges without a second roundtrip. Connections that
 * predate the wallet-discovery feature have an empty source_wallets array
 * and use the legacy account-wide sync path.
 *
 * POST body:
 *   subaccount_id?: uuid  required in platform mode
 *
 * Response:
 *   { connections: [{
 *       id, provider_type, encrypted_label, encrypted_credentials,
 *       status, last_sync_at, last_sync_cursor, encrypted_last_error,
 *       credentials_key_version, created_at,
 *       source_wallets: [{ id, external_wallet_id, is_synced, encrypted_metadata }]
 *     }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';

interface SourceWalletRow {
  id: string;
  connection_id: string;
  external_wallet_id: string;
  is_synced: boolean;
  encrypted_metadata: string;
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    const body = JSON.parse(raw || '{}') as { subaccount_id?: string };

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const { data: rows, error } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_label, encrypted_credentials, credentials_key_version, status, last_sync_at, last_sync_cursor, encrypted_last_error, created_at')
      .eq('subaccount_id', subaccountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[or-connection-list] query failed:', error);
      return jsonResponse({ error: 'Failed to list connections' }, 500, cors);
    }

    const connections = rows ?? [];

    // Bulk-load source_wallets for all returned connections in one round trip
    // (avoids N+1) and group them client-side. RLS already enforced
    // ownership on the connections lookup; source_wallets fetched via the
    // service-role client are filtered by connection_id IN (...) which is
    // safe because that ID set was just authorized above.
    let walletsByConn = new Map<string, SourceWalletRow[]>();
    if (connections.length > 0) {
      const connIds = connections.map(c => (c as { id: string }).id);
      const { data: walletRows, error: walletErr } = await ctx.serviceClient
        .from('source_wallets')
        .select('id, connection_id, external_wallet_id, is_synced, encrypted_metadata')
        .in('connection_id', connIds);

      if (walletErr) {
        console.error('[or-connection-list] source_wallets query failed:', walletErr);
        // Non-fatal: surface connections without wallet badges rather than
        // blocking the whole list. UI degrades to "Default account" rendering.
      } else {
        walletsByConn = new Map();
        for (const w of (walletRows ?? []) as SourceWalletRow[]) {
          const arr = walletsByConn.get(w.connection_id) ?? [];
          arr.push(w);
          walletsByConn.set(w.connection_id, arr);
        }
      }
    }

    const enriched = connections.map(c => {
      const conn = c as { id: string };
      const walletsForConn = (walletsByConn.get(conn.id) ?? []).map(w => ({
        id: w.id,
        external_wallet_id: w.external_wallet_id,
        is_synced: w.is_synced,
        encrypted_metadata: w.encrypted_metadata,
      }));
      return { ...c, source_wallets: walletsForConn };
    });

    return jsonResponse({ connections: enriched }, 200, cors);
  } catch (err) {
    console.error('[or-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
