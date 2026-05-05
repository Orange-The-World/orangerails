/**
 * or-stealth-transactions-store — append SealedTransaction[] for a connection.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * The widget popup calls this at the end of a sync. The server stores the
 * sealed records as opaque bytes and updates last_block_scanned / last_sync_at
 * on the parent stealth_connections row. The (connection_id, txid_blind_index_b64)
 * UNIQUE constraint provides idempotent dedup on retry.
 *
 * POST body:
 *   connection_id:        string (uuid)
 *   app_user_id:          string (uuid)
 *   sealed_transactions:  SealedTransactionInput[]
 *   last_block_scanned:   number
 *
 * Response:
 *   { connection_id, inserted, total, skipped_duplicates, last_block_scanned }
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
  total: number;
  skipped_duplicates: number;
  last_block_scanned: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cap at 10k transactions per request and 16 KB per sealed record. A whole
// 5-year wallet history with ~500 txs comes in well under that.
const MAX_TX_PER_REQUEST = 10_000;
const MAX_SEALED_RECORD_BYTES = 16_384;

function isSealedTx(x: unknown): x is SealedTransactionInput {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    o.algorithm === 'AES-256-GCM' &&
    typeof o.iv_b64 === 'string' &&
    typeof o.ciphertext_b64 === 'string' &&
    typeof o.occurred_at === 'string' &&
    ISO_DATE_RE.test(o.occurred_at as string) &&
    typeof o.block_height === 'number' &&
    Number.isInteger(o.block_height) &&
    (o.block_height as number) >= 0 &&
    typeof o.txid_blind_index_b64 === 'string' &&
    (o.txid_blind_index_b64 as string).length > 0
  );
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

    // ── Validate ──────────────────────────────────────────────────────
    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || !UUID_RE.test(body.app_user_id)) {
      return jsonResponse({ error: 'app_user_id (uuid) required' }, 400, cors);
    }
    if (!Array.isArray(body.sealed_transactions)) {
      return jsonResponse({ error: 'sealed_transactions must be an array' }, 400, cors);
    }
    if (body.sealed_transactions.length > MAX_TX_PER_REQUEST) {
      return jsonResponse(
        { error: `sealed_transactions exceeds max ${MAX_TX_PER_REQUEST} per request` },
        413, cors,
      );
    }
    for (let i = 0; i < body.sealed_transactions.length; i++) {
      const tx = body.sealed_transactions[i];
      if (!isSealedTx(tx)) {
        return jsonResponse(
          { error: `sealed_transactions[${i}] is malformed` },
          400, cors,
        );
      }
      if (JSON.stringify(tx).length > MAX_SEALED_RECORD_BYTES) {
        return jsonResponse(
          { error: `sealed_transactions[${i}] exceeds max size` },
          413, cors,
        );
      }
    }
    if (
      body.last_block_scanned === undefined ||
      typeof body.last_block_scanned !== 'number' ||
      !Number.isInteger(body.last_block_scanned) ||
      body.last_block_scanned < 0
    ) {
      return jsonResponse(
        { error: 'last_block_scanned must be a non-negative integer' },
        400, cors,
      );
    }

    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    // Verify the connection belongs to the caller. Defense in depth on top
    // of the UNIQUE constraint check; saves us from quietly inserting tx
    // rows under a connection_id the caller does not own.
    const { data: ownerRow, error: ownerErr } = await ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_user_id')
      .eq('id', body.connection_id)
      .maybeSingle();
    if (ownerErr) {
      console.error('[or-stealth-transactions-store] owner check failed:', ownerErr);
      return jsonResponse({ error: 'Failed to verify connection' }, 500, cors);
    }
    if (!ownerRow) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }
    if ((ownerRow.app_user_id as string) !== body.app_user_id) {
      return jsonResponse({ error: 'Connection does not belong to caller' }, 403, cors);
    }

    const total = body.sealed_transactions.length;

    // ── Idempotent insert: ON CONFLICT (connection_id, txid_blind_index_b64) DO NOTHING ──
    // supabase-js exposes this through `upsert(..., { onConflict, ignoreDuplicates: true })`.
    // We then count what was actually stored vs what was already there by selecting
    // the txid_blind_index_b64 set after.
    let inserted = 0;
    let skipped_duplicates = 0;

    if (total > 0) {
      const rows = body.sealed_transactions.map((tx) => ({
        connection_id: body.connection_id,
        sealed_record: {
          version: tx.version,
          algorithm: tx.algorithm,
          iv_b64: tx.iv_b64,
          ciphertext_b64: tx.ciphertext_b64,
        },
        occurred_at: tx.occurred_at,
        block_height: tx.block_height,
        txid_blind_index_b64: tx.txid_blind_index_b64,
      }));

      // Count duplicates BEFORE insert by checking which txid blind indexes
      // already exist for this connection. Cheaper than counting after when
      // total is bounded.
      const blinds = body.sealed_transactions.map((t) => t.txid_blind_index_b64);
      const { data: pre, error: preErr } = await ctx.serviceClient
        .from('stealth_transactions')
        .select('txid_blind_index_b64')
        .eq('connection_id', body.connection_id)
        .in('txid_blind_index_b64', blinds);
      if (preErr) {
        console.error('[or-stealth-transactions-store] dedup pre-check failed:', preErr);
        return jsonResponse({ error: 'Failed to dedup-check transactions' }, 500, cors);
      }
      const existing = new Set(((pre ?? []) as Array<{ txid_blind_index_b64: string }>).map((r) => r.txid_blind_index_b64));
      const fresh = rows.filter((r) => !existing.has(r.txid_blind_index_b64 as string));
      skipped_duplicates = total - fresh.length;

      if (fresh.length > 0) {
        const { error: insErr } = await ctx.serviceClient
          .from('stealth_transactions')
          .upsert(fresh, {
            onConflict: 'connection_id,txid_blind_index_b64',
            ignoreDuplicates: true,
          });
        if (insErr) {
          console.error('[or-stealth-transactions-store] insert failed:', insErr);
          return jsonResponse({ error: 'Failed to insert transactions' }, 500, cors);
        }
        inserted = fresh.length;
      }
    }

    const { error: updErr } = await ctx.serviceClient
      .from('stealth_connections')
      .update({
        last_block_scanned: body.last_block_scanned,
        last_sync_at: new Date().toISOString(),
      })
      .eq('id', body.connection_id);
    if (updErr) {
      console.error('[or-stealth-transactions-store] connection update failed:', updErr);
      return jsonResponse({ error: 'Failed to update connection sync metadata' }, 500, cors);
    }

    const resp: TransactionsStoreResponseBody = {
      connection_id: body.connection_id,
      inserted,
      total,
      skipped_duplicates,
      last_block_scanned: body.last_block_scanned,
    };
    return jsonResponse(resp, 200, cors);
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
