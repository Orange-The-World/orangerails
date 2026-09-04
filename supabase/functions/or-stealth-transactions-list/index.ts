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
 *   before_block:   number (optional, cursor half 1: block height of the last row seen)
 *   before_txid_blind_index_hex:
 *                   string (optional, cursor half 2: blind index of the last row seen).
 *                   Must be supplied together with before_block; neither half is
 *                   accepted alone. See "Pagination" below for why.
 *
 * Response:
 *   {
 *     connection_id: string,
 *     transactions: SealedTransactionRow[],  // ordered block_height DESC, txid_blind_index_hex DESC
 *     total:        number,                  // total rows for this connection (all pages)
 *     has_more:     boolean,                 // true when more rows exist past this page
 *     next_cursor:  PageCursor | null        // pass straight back in; null when has_more is false
 *   }
 *
 * Pagination: on has_more=true, send `next_cursor` back verbatim as the next
 * request's cursor fields. Do not build a cursor by hand.
 *
 * Why the cursor has two halves. block_height is NOT unique on this table --
 * the only uniqueness is (connection_id, txid_blind_index_hex), and one block
 * can hold many of a wallet's transactions. An ordering of block_height alone
 * is therefore a partial order, and a `block_height < before_block` cursor
 * built on it silently DROPS every remaining row of a block whenever a page
 * boundary lands inside that block. The unstable tie also lets the same row
 * come back twice on different calls. Ordering and cursor are both extended
 * with txid_blind_index_hex, which is unique per connection, so the sort is a
 * total order and the cursor names exactly one row.
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

/**
 * Lowercase 64-char hex, same shape or-stealth-transactions-store enforces on
 * write and the same shape the column comment documents.
 *
 * This regex is also the injection guard. The cursor predicate below is a
 * PostgREST filter STRING, so a value carrying `,` `.` `(` or `)` would be
 * parsed as filter syntax rather than as data. Hex admits none of those
 * characters. Do not loosen this to a generic string check.
 *
 * JavaScript's `$` matches end-of-string OR immediately before a trailing
 * newline, so this pattern alone admits a 65-character value: 64 hex
 * characters plus "\n". That extra byte is not `,` `.` `(` or `)`, so it
 * cannot break out of the filter expression, but it is not hex either, and
 * this regex on its own does not guarantee "exactly 64 hex characters".
 * Every caller MUST pair this test with an explicit `.length === 64` check.
 */
const BLIND_INDEX_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * The page ordering, as data rather than as two .order() calls, so the
 * pagination test can build its comparator from the very same array that
 * production sorts by. A test that hardcodes its own copy of the ordering
 * cannot fail when production's ordering changes, which is the failure this
 * export exists to prevent.
 *
 * Both columns descend: newest block first, and within a block a stable
 * unique tiebreaker.
 */
export const PAGE_ORDER = [
  { column: 'block_height', ascending: false },
  { column: 'txid_blind_index_hex', ascending: false },
] as const;

/** Names exactly one row: the last row of the page just returned. */
export interface PageCursor {
  before_block: number;
  before_txid_blind_index_hex: string;
}

/**
 * The keyset predicate for "strictly after this cursor in PAGE_ORDER",
 * as a PostgREST .or() expression:
 *
 *   block_height < before_block
 *   OR (block_height = before_block AND txid_blind_index_hex < before_txid)
 *
 * Keyset, not OFFSET: rows inserted by a concurrent sync do not shift the
 * window under a paging caller.
 *
 * Callers MUST validate both halves before calling this. It interpolates
 * into filter syntax and performs no escaping of its own.
 */
export function cursorOrExpression(cursor: PageCursor): string {
  const b = cursor.before_block;
  const t = cursor.before_txid_blind_index_hex;
  return `block_height.lt.${b},and(block_height.eq.${b},txid_blind_index_hex.lt.${t})`;
}

/**
 * The cursor a caller should send to get the next page: the last row of this
 * page. Null when there is no next page, so a caller that blindly follows a
 * non-null cursor terminates.
 */
export function nextCursorFrom(
  pageRows: ReadonlyArray<{ block_height: number; txid_blind_index_hex: string }>,
  hasMore: boolean,
): PageCursor | null {
  if (!hasMore || pageRows.length === 0) return null;
  const last = pageRows[pageRows.length - 1];
  return {
    before_block: last.block_height,
    before_txid_blind_index_hex: last.txid_blind_index_hex,
  };
}

interface TransactionsListRequestBody {
  connection_id?: string;
  app_user_id?: string;
  widget_token?: string;
  limit?: number;
  /** Cursor half 1: block_height of the last row the caller has already seen. */
  before_block?: number;
  /** Cursor half 2: txid_blind_index_hex of that same row. Required with before_block. */
  before_txid_blind_index_hex?: string;
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
  /** True when more rows exist past the current page. */
  has_more: boolean;
  /** Send back verbatim to fetch the next page. Null when has_more is false. */
  next_cursor: PageCursor | null;
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
    if (
      !body.connection_id ||
      body.connection_id.length !== 36 ||
      !UUID_RE.test(body.connection_id)
    ) {
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

    // Validate the cursor. Both halves or neither: a half cursor is exactly
    // the lossy partial-order cursor this endpoint must not offer, so it is
    // rejected rather than quietly interpreted as "block_height < n".
    const hasBlock = body.before_block !== undefined;
    const hasTxid = body.before_txid_blind_index_hex !== undefined;
    if (hasBlock !== hasTxid) {
      return jsonResponse(
        {
          error:
            'before_block and before_txid_blind_index_hex must be supplied together; ' +
            'send the next_cursor from the previous page unchanged',
        },
        400, cors,
      );
    }
    if (
      hasBlock &&
      (typeof body.before_block !== 'number' ||
        !Number.isInteger(body.before_block) ||
        body.before_block < 0)
    ) {
      return jsonResponse({ error: 'before_block must be a non-negative integer' }, 400, cors);
    }
    // Strict hex, because this value is interpolated into a PostgREST filter
    // expression. See BLIND_INDEX_HEX_RE.
    if (
      hasTxid &&
      (typeof body.before_txid_blind_index_hex !== 'string' ||
        body.before_txid_blind_index_hex.length !== 64 ||
        !BLIND_INDEX_HEX_RE.test(body.before_txid_blind_index_hex))
    ) {
      return jsonResponse(
        { error: 'before_txid_blind_index_hex must be 64 lowercase hex characters' },
        400, cors,
      );
    }
    const cursor: PageCursor | null = hasBlock
      ? {
          before_block: body.before_block as number,
          before_txid_blind_index_hex: body.before_txid_blind_index_hex as string,
        }
      : null;

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
    let txQuery = ctx.serviceClient
      .from('stealth_transactions')
      .select('id, sealed_record, occurred_at, block_height, txid_blind_index_hex, created_at')
      .eq('connection_id', body.connection_id);

    // Ordering comes from PAGE_ORDER rather than from literal .order() calls
    // so that production and the pagination test cannot drift apart.
    for (const o of PAGE_ORDER) {
      txQuery = txQuery.order(o.column, { ascending: o.ascending });
    }
    txQuery = txQuery.limit(limit + 1);

    if (cursor) {
      txQuery = txQuery.or(cursorOrExpression(cursor));
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
      next_cursor: nextCursorFrom(transactions, has_more),
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
