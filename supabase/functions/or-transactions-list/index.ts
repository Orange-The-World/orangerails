/**
 * or-transactions-list , list encrypted transactions for a subaccount.
 *
 * Returns encrypted blobs as-is. The caller's browser decrypts with ORT.
 *
 * POST body:
 *   subaccount_id?: uuid       required in platform mode
 *   limit?:         number     default 50, max 200
 *   before?:        timestamptz cursor for pagination (occurred_at < before)
 *
 * Response:
 *   { transactions: [{ id, connection_id, external_id, encrypted_payload, occurred_at }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';

const DEFAULT_LIMIT = 200;
// Bumped from 200 → 1000. The prior cap surfaced as a "support ticket"
// shape , banks with thousands of historical transactions appeared to
// only sync 200 because the client only made one call. Clients should
// still paginate with `before_occurred_at` / `cursor` for full history.
const MAX_LIMIT = 1000;

// Per-response byte cap. encrypted_payload is unbounded base64 ciphertext
// (no DB CHECK), so 1000 rows × N KB can hit edge-function memory limits
// or trip statement_timeout mid-stream. We early-cut the response when the
// running ciphertext byte total crosses this threshold and return a
// cursor for the client to resume. Picked at 4 MB to leave headroom under
// Supabase's 6 MB response cap.
const MAX_RESPONSE_PAYLOAD_BYTES = 4 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    const body = JSON.parse(raw || '{}') as { subaccount_id?: string; limit?: number; before?: string };

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    // Find connection IDs belonging to this subaccount, then list their transactions.
    const { data: conns } = await ctx.serviceClient
      .from('connections')
      .select('id')
      .eq('subaccount_id', subaccountId);
    const connIds = (conns ?? []).map(c => c.id as string);
    if (connIds.length === 0) return jsonResponse({ transactions: [] }, 200, cors);

    let q = ctx.serviceClient
      .from('encrypted_transactions')
      .select('id, connection_id, external_id, encrypted_payload, occurred_at')
      .in('connection_id', connIds)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (body.before) q = q.lt('occurred_at', body.before);

    const { data: rows, error } = await q;
    if (error) {
      console.error('[or-transactions-list] query failed:', error);
      return jsonResponse({ error: 'Failed to list transactions' }, 500, cors);
    }

    // Byte-cap the response. Walk rows in order, summing encrypted_payload
    // length; stop as soon as we'd cross MAX_RESPONSE_PAYLOAD_BYTES. Return
    // the last included row's occurred_at as next_before so the client can
    // resume with one more call. Truncation only fires for genuinely huge
    // payloads , most callers will receive every row they asked for.
    const out: typeof rows = [];
    let byteTotal = 0;
    let truncated = false;
    for (const row of rows ?? []) {
      const payloadLen = (row.encrypted_payload as string | null)?.length ?? 0;
      if (out.length > 0 && byteTotal + payloadLen > MAX_RESPONSE_PAYLOAD_BYTES) {
        truncated = true;
        break;
      }
      out.push(row);
      byteTotal += payloadLen;
    }
    const next_before = truncated && out.length > 0
      ? (out[out.length - 1].occurred_at as string)
      : null;

    return jsonResponse(
      { transactions: out, truncated, next_before },
      200,
      cors,
    );
  } catch (err) {
    console.error('[or-transactions-list] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
