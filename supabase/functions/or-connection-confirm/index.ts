/**
 * or-connection-confirm , flip a pending connection to active.
 *
 * Part of the atomic connect-flow state machine (audit 2026-05-21
 * finding N6). After or-link-complete returns with status='pending',
 * the consumer persists its own local link record; only on success
 * does it call this endpoint to commit OR's side. If the consumer
 * never calls confirm (crash, modal closed, network failure), the
 * janitor deletes the row after 10 minutes.
 *
 * Auth: X-Platform-API-Key (platform mode only , direct-mode users
 * don't go through or-link-complete in the first place).
 *
 * POST body:
 *   connection_id:  uuid  the pending connection to confirm
 *   subaccount_id:  uuid  required in platform mode
 *
 * Response:
 *   200 { ok: true, status: 'active' }   , pending → active (or already-active idempotent)
 *   400                                  , missing/invalid body
 *   401                                  , auth failure
 *   404 { error: 'Connection not found' }, wrong owner or no such id (don't leak)
 *   409 { error: ... }                   , connection in some other state (e.g. error/disconnected)
 *   500                                  , DB failure
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import {
import { wrapSentryHandler } from '../_shared/sentry.ts';
  confirmConnection,
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
      // Don't distinguish "no such id" from "belongs to another tenant".
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    const result = await confirmConnection(ctx.serviceClient, conn);
    if (result === 'invalid_state') {
      return jsonResponse(
        { error: `Cannot confirm connection in status '${conn.status}'` },
        409,
        cors,
      );
    }
    return jsonResponse({ ok: true, status: 'active' }, 200, cors);
  } catch (err) {
    console.error('[or-connection-confirm] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-connection-confirm'));
