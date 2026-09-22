/**
 * or-stealth-utxos-fetch -- read the persisted sealed UTXO set for a connection.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md section 4.6. OR-T0049 PR 2a.
 *
 * The client's UTXO tracker in sync.ts is in-memory for a single sync run:
 * a spend of a UTXO received in an earlier run is never detected unless
 * that run's ending UTXO set is fed back in as the starting point of the
 * next one. upsert_stealth_utxos (OR-T0549/OR-T0554) already
 * persists that set after a run. This function is the read half: the
 * widget calls it BEFORE a sync starts, to seed the matcher.
 *
 * The sealed bytes are opaque end to end. This function selects and
 * returns exactly what was stored; it never parses or decrypts
 * sealed_utxos, the same way or-stealth-transactions-store never parses or
 * decrypts a sealed transaction.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string
 *   widget_token:  string, optional (widget-mode credential, see sibling
 *                  functions for the auth modes this shares)
 *
 * Response:
 *   { connection_id, sealed_utxos: SealedEnvelope | null, scanned_to: number | null }
 *   Both fields are null when the connection has never had a UTXO set
 *   persisted (no prior PR-2 sync has completed for it yet). That is a
 *   healthy, expected state, not an error.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import {
  authenticateRequestOrWidgetToken,
  enforceWidgetAppUser,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface UtxosFetchRequestBody {
  connection_id?: string;
  app_user_id?: string;
  widget_token?: string;
}

/** The opaque sealed envelope shape produced by src/stealth/lib/seal.ts. */
interface SealedEnvelopeLike {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv_b64: string;
  ciphertext_b64: string;
}

interface UtxosFetchResponseBody {
  connection_id: string;
  sealed_utxos: SealedEnvelopeLike | null;
  scanned_to: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when x has the exact shape sealEnvelope() produces. Guards against
 * returning a malformed row (e.g. from a manual DB edit or a future schema
 * change) as if it were a usable envelope; the caller would otherwise fail
 * far away from here, inside unsealEnvelope, with no context.
 */
function isSealedEnvelopeLike(x: unknown): x is SealedEnvelopeLike {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    o.algorithm === 'AES-256-GCM' &&
    typeof o.iv_b64 === 'string' &&
    typeof o.ciphertext_b64 === 'string'
  );
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    // Body read before auth: widget-mode presents its credential in the
    // body, same as every sibling or-stealth-* function.
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    let body: UtxosFetchRequestBody;
    try {
      body = JSON.parse(raw || '{}') as UtxosFetchRequestBody;
    } catch {
      return jsonResponse({ error: 'Request body is not valid JSON' }, 400, cors);
    }

    const ctx = await authenticateRequestOrWidgetToken(req, body.widget_token);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }

    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403,
        cors,
      );
    }
    const widgetUserErr = enforceWidgetAppUser(ctx, body.app_user_id);
    if (widgetUserErr) {
      return jsonResponse({ error: widgetUserErr.message }, widgetUserErr.status, cors);
    }

    // Same platform-scoping requirement as every sibling function (Audit
    // 2026-05-16 High #2): every stealth_connections read must be bound to
    // the calling platform.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    // Verify ownership through stealth_connections before touching
    // stealth_utxos at all. This mirrors the pattern in
    // or-stealth-envelope-update and or-stealth-transactions-store: the
    // service-role client bypasses RLS, so this application-level check is
    // what stops a caller from fetching another user's UTXO set.
    const { data: ownerRow, error: ownerErr } = await ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_user_id')
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .maybeSingle();
    if (ownerErr) {
      console.error('[or-stealth-utxos-fetch] owner check failed:', ownerErr);
      return jsonResponse({ error: 'Failed to verify connection' }, 500, cors);
    }
    if (!ownerRow) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }
    if ((ownerRow.app_user_id as string) !== body.app_user_id) {
      return jsonResponse({ error: 'Connection does not belong to caller' }, 403, cors);
    }

    const { data: utxoRow, error: utxoErr } = await ctx.serviceClient
      .from('stealth_utxos')
      .select('sealed_utxos, scanned_to')
      .eq('connection_id', body.connection_id)
      .maybeSingle();
    if (utxoErr) {
      console.error('[or-stealth-utxos-fetch] select failed:', utxoErr);
      return jsonResponse({ error: 'Failed to load stored UTXO set' }, 500, cors);
    }

    // No row yet is a healthy state (no PR-2 sync has completed for this
    // connection), not an error: return nulls rather than 404, so the
    // caller's happy path is "seed with whatever came back" with no
    // special-casing of a missing row.
    const rawSealed = utxoRow?.sealed_utxos ?? null;
    const sealed_utxos = isSealedEnvelopeLike(rawSealed) ? rawSealed : null;
    if (rawSealed !== null && sealed_utxos === null) {
      // A row exists but does not look like a sealed envelope. Loud, not
      // silent: this is either a future schema change this function has
      // not caught up with, or data corruption, and either way seeding the
      // matcher with garbage is worse than the client re-scanning.
      console.error(
        '[or-stealth-utxos-fetch] stored sealed_utxos does not match the expected shape for connection',
        body.connection_id,
      );
      return jsonResponse({ error: 'Stored UTXO set is malformed' }, 500, cors);
    }

    const resp: UtxosFetchResponseBody = {
      connection_id: body.connection_id,
      sealed_utxos,
      scanned_to: sealed_utxos ? (utxoRow!.scanned_to as number) : null,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-utxos-fetch] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-utxos-fetch'));

export type { UtxosFetchRequestBody, UtxosFetchResponseBody, SealedEnvelopeLike };
