/**
 * or-stealth-transactions-store — append SealedTransaction[] for a connection.
 *
 * Milestone 1 stub. Full behavior in STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * The widget popup calls this at the end of a sync. The server stores the
 * sealed records as opaque bytes and updates last_block_scanned / last_sync_at
 * on the parent stealth_connections row. The (connection_id, txid_blind_index_b64)
 * UNIQUE constraint provides idempotent dedup on retry.
 *
 * POST body:
 *   connection_id:        string (uuid)
 *   app_user_id:          string (uuid)
 *   sealed_transactions:  SealedTransaction[]    // see src/stealth/lib/postmessage.ts
 *   last_block_scanned:   number
 *
 * Response:
 *   { connection_id, inserted: number, skipped_duplicates: number,
 *     last_block_scanned: number }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

interface SealedTransactionInput {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv_b64: string;
  ciphertext_b64: string;
  occurred_at: string;
  block_height: number;
  txid_blind_index_b64: string;
}

interface TransactionsStoreRequestBody {
  connection_id?: string;
  app_user_id?: string;
  sealed_transactions?: SealedTransactionInput[];
  last_block_scanned?: number;
}

interface TransactionsStoreResponseBody {
  connection_id: string;
  inserted: number;
  skipped_duplicates: number;
  last_block_scanned: number;
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
    const body = JSON.parse(raw || '{}') as TransactionsStoreRequestBody;

    // TODO(milestone-1): validate body shape + per-record fields, batch upsert
    // into stealth_transactions with ON CONFLICT DO NOTHING on
    // (connection_id, txid_blind_index_b64), then update the parent row's
    // last_block_scanned + last_sync_at.
    void body;
    void ctx;

    return jsonResponse(
      { error: 'or-stealth-transactions-store not yet implemented' },
      501,
      cors,
    );
  } catch (err) {
    console.error('[or-stealth-transactions-store] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type {
  SealedTransactionInput,
  TransactionsStoreRequestBody,
  TransactionsStoreResponseBody,
};
