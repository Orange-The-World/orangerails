/**
 * or-connection-cancel , delete a pending connection.
 *
 * Part of the atomic connect-flow state machine (audit 2026-05-21
 * finding N6). Called by a consumer when its own local persist
 * fails (Save Wallet error, user closed the modal, network blip)
 * so the in-flight OR row is cleaned up immediately instead of
 * sitting orphan until the 10-minute janitor sweep.
 *
 * Refuses to cancel an active connection , the consumer must use
 * or-connection-delete for that and accept it as a destructive
 * "fully connected, now disconnect" action with whatever UX
 * implications that carries.
 *
 * Auth: X-Platform-API-Key (platform mode only , direct-mode users
 * don't go through or-link-complete in the first place).
 *
 * POST body:
 *   connection_id:  uuid  the pending connection to cancel
 *   subaccount_id:  uuid  required in platform mode
 *
 * Response:
 *   200 { ok: true, status: 'cancelled' }     , pending row deleted
 *   400                                       , missing/invalid body
 *   401                                       , auth failure
 *   404 { error: 'Connection not found' }     , wrong owner, no such id, or
 *                                               already cancelled (idempotent)
 *   409 { error: 'Connection already active; cannot cancel. Use or-connection-delete to remove.' }
 *   500                                       , DB failure
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  cancelPendingConnection,
  fetchScopedConnection,
  isValidUuid,
} from '../_shared/connection-state.ts';

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    let body: { connection_id?: unknown; subaccount_id?: unknown };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, cors);
    }

    if (!isValidUuid(body.connection_id)) {
      return jsonResponse({ error: 'connection_id required (uuid)' }, 400, cors);
    }

    const subaccountId = await resolveSubaccount(
      ctx,
      typeof body.subaccount_id === 'string' ? body.subaccount_id : undefined,
    );
    if (isAuthError(subaccountId)) {
      return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);
    }

    const conn = await fetchScopedConnection(ctx.serviceClient, body.connection_id, subaccountId);
    if (!conn) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    const result = await cancelPendingConnection(ctx.serviceClient, conn);
    if (result === 'already_active') {
      return jsonResponse(
        { error: 'Connection already active; cannot cancel. Use or-connection-delete to remove.' },
        409,
        cors,
      );
    }
    if (result === 'invalid_state') {
      return jsonResponse(
        { error: `Cannot cancel connection in status '${conn.status}'` },
        409,
        cors,
      );
    }
    return jsonResponse({ ok: true, status: 'cancelled' }, 200, cors);
  } catch (err) {
    console.error('[or-connection-cancel] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-connection-cancel'));
