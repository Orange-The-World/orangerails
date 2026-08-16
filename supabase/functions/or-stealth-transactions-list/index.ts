/**
 * or-stealth-transactions-list -- list sealed transactions for a stealth connection.
 *
 * The browser widget calls this to retrieve the sealed records stored by
 * or-stealth-transactions-store, ordered newest-block-first, so it can
 * display transaction history after client-side decryption without running
 * a full BIP158 rescan.
 *
 * Row shape is intentionally distinct from the envelope path: one row per
 * stored sealed transaction, keyed on block_height. No union query.
 *
 * Three auth modes (same surface as or-stealth-transactions-store):
 *   Platform mode  -- X-Platform-API-Key header
 *   Direct mode    -- Supabase JWT in Authorization header
 *   Widget mode    -- widget_token in request body
 *
 * POST body:
 *   connection_id:  string (uuid, required)
 *   app_user_id:    string (required)
 *   widget_token:   string (optional, widget mode credential)
 *   limit:          number (optional, default 100, max 1000)
 *   before_block:   number (optional, cursor: only rows with block_height < before_block)
 *
 * Response:
 *   {
 *     connection_id: string,
 *     transactions: SealedTransactionRow[],  // ordered block_height DESC
 *     total:        number,                  // total rows for this connection (all pages)
 *     has_more:     boolean                  // true when more rows exist past this page
 *   }
 *
 * Pagination: on has_more=true, re-call with before_block set to the
 * block_height of the last row in the current page.
 *
 * Refs DL-1174.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import {
  authenticateRequestOrWidgetToken,
  enforceWidgetAppUser,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface TransactionsListRequestBody {
  connection_id?: string;
  app_user_id?: string;
  widget_token?: string;
  limit?: number;
  /** Cursor: return only rows with block_height strictly less than this value. */
  before_block?: number;
}

interface SealedTransactionRow {
  id: string;
  sealed_record: {
    version: 1;
    algorithm: 'AES-256-GCM';
    iv_b64: string;
    ciphertext_b64: string;
  };
  /** Plaintext block date (ZKA Level 2 trade-off, per STEALTH-SYNC-MASTER-PLAN.md §4.3). */
  occurred_at: string;
  block_height: number;
  txid_blind_index_hex: string;
  created_at: string;
}

interface TransactionsListResponseBody {
  connection_id: string;
  transactions: SealedTransactionRow[];
  /** Total stored rows for this connection across all pages. */
  total: number;
  /** True when more rows exist past the current page; paginate with before_block. */
  has_more: boolean;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    // Read body before auth: widget-mode credential lives in the body.
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    let body: TransactionsListRequestBody;
    try {
      body = JSON.parse(raw || '{}') as TransactionsListRequestBody;
    } catch {
      return jsonResponse({ error: 'Request body is not valid JSON' }, 400, cors);
    }

    const ctx = await authenticateRequestOrWidgetToken(req, body.widget_token);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    // Validate required fields.
    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }

    // Direct mode: user may only read their own transactions.
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    // Widget mode: token pins one app_user_id.
    const widgetUserErr = enforceWidgetAppUser(ctx, body.app_user_id);
    if (widgetUserErr) {
      return jsonResponse({ error: widgetUserErr.message }, widgetUserErr.status, cors);
    }

    // Validate limit.
    let limit = DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      if (
        typeof body.limit !== 'number' ||
        !Number.isInteger(body.limit) ||
        body.limit < 1
      ) {
        return jsonResponse({ error: 'limit must be a positive integer' }, 400, cors);
      }
      limit = Math.min(body.limit, MAX_LIMIT);
    }

    // Validate before_block cursor.
    if (
      body.before_block !== undefined &&
      (typeof body.before_block !== 'number' ||
        !Number.isInteger(body.before_block) ||
        body.before_block < 0)
    ) {
      return jsonResponse({ error: 'before_block must be a non-negative integer' }, 400, cors);
    }

    // Bind to calling platform (audit 2026-05-16 High #2).
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    // Ownership gate: verify the connection belongs to this caller before
    // touching stealth_transactions. Same defense-in-depth pattern as the store.
    const { data: ownerRow, error: ownerErr } = await ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_user_id')
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .maybeSingle();
    if (ownerErr) {
      console.error('[or-stealth-transactions-list] owner check failed:', ownerErr);
      return jsonResponse({ error: 'Failed to verify connection' }, 500, cors);
    }
    if (!ownerRow) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }
    if ((ownerRow.app_user_id as string) !== body.app_user_id) {
      return jsonResponse({ error: 'Connection does not belong to caller' }, 403, cors);
    }

    // Count total rows for this connection. Returned on every page so the
    // widget can show overall progress without exhausting all pages.
    const { count: totalCount, error: countErr } = await ctx.serviceClient
      .from('stealth_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', body.connection_id);
    if (countErr) {
      console.error('[or-stealth-transactions-list] count failed:', countErr);
      return jsonResponse({ error: 'Failed to count transactions' }, 500, cors);
    }
    const total = totalCount ?? 0;

    // Fetch page. Fetch limit+1 rows to detect has_more without a second query.
    // Uses the (connection_id, block_height DESC) index.
    let txQuery = ctx.serviceClient
      .from('stealth_transactions')
      .select('id, sealed_record, occurred_at, block_height, txid_blind_index_hex, created_at')
      .eq('connection_id', body.connection_id)
      .order('block_height', { ascending: false })
      .limit(limit + 1);

    if (body.before_block !== undefined) {
      txQuery = txQuery.lt('block_height', body.before_block);
    }

    const { data: rows, error: selErr } = await txQuery;
    if (selErr) {
      console.error('[or-stealth-transactions-list] select failed:', selErr);
      return jsonResponse({ error: 'Failed to list transactions' }, 500, cors);
    }

    const allRows = rows ?? [];
    const has_more = allRows.length > limit;
    const pageRows = has_more ? allRows.slice(0, limit) : allRows;

    const transactions: SealedTransactionRow[] = pageRows.map((r) => ({
      id: r.id as string,
      sealed_record: r.sealed_record as SealedTransactionRow['sealed_record'],
      occurred_at: r.occurred_at as string,
      block_height: r.block_height as number,
      txid_blind_index_hex: r.txid_blind_index_hex as string,
      created_at: r.created_at as string,
    }));

    const resp: TransactionsListResponseBody = {
      connection_id: body.connection_id,
      transactions,
      total,
      has_more,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-transactions-list] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-transactions-list'));

export type {
  TransactionsListRequestBody,
  TransactionsListResponseBody,
  SealedTransactionRow,
};
