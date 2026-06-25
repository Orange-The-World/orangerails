/**
 * or-quiltt-disconnect , unlink a user's Quiltt connection(s).
 *
 * Tears down the link in both directions:
 *   1. Calls Quiltt GraphQL `connectionDisconnect` (best-effort) so Quiltt
 *      stops billing for the connection and stops pushing webhooks.
 *   2. Deletes the OR connections row for this subaccount + provider='quiltt'
 *      (which cascades to encrypted_transactions via FK).
 *   3. Marks any unprocessed quiltt_webhook_inbox rows for this subaccount
 *      processed so the worker stops trying to drain them.
 *
 * Optionally also deletes the quiltt_profile_map row (when full_unlink=true)
 * , that wipes the (subaccount → Quiltt Profile) mapping so a future
 * or-quiltt-session call mints a fresh Profile. Default false: keep the
 * mapping so the user can re-link the same Profile cheaply.
 *
 * Auth: X-Platform-API-Key (platform mode only).
 *
 * POST body:
 *   {
 *     app_user_id:   string                  // integrating app's user id
 *     connection_id?: string                 // Quiltt connection id to drop;
 *                                            // when omitted, drops the OR
 *                                            // connections row entirely
 *                                            // (all Quiltt links for this user)
 *     full_unlink?:  boolean                 // also wipe quiltt_profile_map
 *   }
 *
 * Response 200:
 *   {
 *     ok: true,
 *     quiltt_disconnected:    boolean,       // was the GraphQL mutation 2xx
 *     or_connection_deleted:  boolean,       // did we delete the OR row
 *     inbox_events_voided:    number,
 *     profile_map_deleted:    boolean
 *   }
 *
 * Failure modes:
 *   - 401 platform auth
 *   - 404 subaccount missing (nothing to disconnect)
 *   - 200 with quiltt_disconnected=false if the GraphQL call fails , we still
 *     proceed with the OR-side cleanup so the user isn't stuck with a dead
 *     link in their app. Ops can replay the disconnect manually if needed.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const QUILTT_GRAPHQL = 'https://api.quiltt.io/v1/graphql';

interface DisconnectBody {
  app_user_id?:   string;
  connection_id?: string;
  full_unlink?:   boolean;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const auth = await authenticateRequest(req);
    if (isAuthError(auth)) return jsonResponse({ error: auth.message }, auth.status, cors);
    if (auth.mode !== 'platform') {
      return jsonResponse(
        { error: 'or-quiltt-disconnect requires platform-mode auth (X-Platform-API-Key)' },
        403, cors,
      );
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as DisconnectBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    if (body.connection_id !== undefined && (typeof body.connection_id !== 'string' || body.connection_id.length > 256)) {
      return jsonResponse({ error: 'connection_id must be a string ≤256 chars' }, 400, cors);
    }

    // Resolve the OR subaccount.
    const sub = await auth.serviceClient
      .from('subaccounts')
      .select('id')
      .eq('platform_id', auth.platformId)
      .eq('external_user_id', body.app_user_id)
      .maybeSingle();
    if (sub.error) {
      console.error('[or-quiltt-disconnect] subaccount lookup failed:', sub.error.message);
      return jsonResponse({ error: 'Failed to resolve subaccount' }, 500, cors);
    }
    if (!sub.data) {
      return jsonResponse({ error: 'No subaccount for this app_user_id' }, 404, cors);
    }
    const subaccountId = sub.data.id as string;

    // Resolve the Quiltt profile id + API key for the GraphQL call.
    const quilttApiKey = Deno.env.get('QUILTT_API_KEY');
    const map = await auth.serviceClient
      .from('quiltt_profile_map')
      .select('quiltt_profile_id')
      .eq('subaccount_id', subaccountId)
      .maybeSingle();

    // 1. Try Quiltt-side disconnect. Best-effort.
    let quilttDisconnected = false;
    if (quilttApiKey && map.data?.quiltt_profile_id && body.connection_id) {
      const basic = btoa(`${map.data.quiltt_profile_id}:${quilttApiKey}`);
      const mutation = `
        mutation Disconnect($id: ID!) {
          connectionDisconnect(input: { id: $id }) {
            connection { id status }
            errors { message }
          }
        }
      `;
      try {
        const resp = await fetch(QUILTT_GRAPHQL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${basic}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ query: mutation, variables: { id: body.connection_id } }),
        });
        if (resp.ok) {
          const json = await resp.json().catch(() => null);
          const errs = json?.data?.connectionDisconnect?.errors;
          if (!errs || errs.length === 0) {
            quilttDisconnected = true;
          } else {
            console.warn(`[or-quiltt-disconnect] Quiltt returned errors: ${JSON.stringify(errs).slice(0, 300)}`);
          }
        } else {
          const text = await resp.text().catch(() => '');
          console.warn(`[or-quiltt-disconnect] Quiltt HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
      } catch (e) {
        console.warn(`[or-quiltt-disconnect] Quiltt fetch threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 2. Delete the OR connections row(s). If connection_id was given we
    //    still delete the OR row entirely , there's one OR connection per
    //    Quiltt Profile (Phase 1 design), all Quiltt links share it.
    let orConnectionDeleted = false;
    const del = await auth.serviceClient
      .from('connections')
      .delete({ count: 'exact' })
      .eq('subaccount_id', subaccountId)
      .eq('provider_type', 'quiltt');
    if (del.error) {
      console.error('[or-quiltt-disconnect] OR connection delete failed:', del.error.message);
    } else {
      orConnectionDeleted = (del.count ?? 0) > 0;
    }

    // 3. Void unprocessed inbox events for this subaccount so the worker
    //    doesn't keep trying to land data into a now-deleted connection.
    let inboxEventsVoided = 0;
    const voidRows = await auth.serviceClient
      .from('quiltt_webhook_inbox')
      .update({
        processed_at: new Date().toISOString(),
        last_error:   'voided-by-disconnect',
      })
      .eq('subaccount_id', subaccountId)
      .is('processed_at', null)
      .select('event_id');
    if (voidRows.error) {
      console.error('[or-quiltt-disconnect] inbox void failed:', voidRows.error.message);
    } else {
      inboxEventsVoided = voidRows.data?.length ?? 0;
    }

    // 4. Optionally wipe the profile mapping (full unlink). Without this,
    //    re-link reuses the existing Quiltt Profile cheaply.
    let profileMapDeleted = false;
    if (body.full_unlink === true) {
      const delMap = await auth.serviceClient
        .from('quiltt_profile_map')
        .delete({ count: 'exact' })
        .eq('subaccount_id', subaccountId);
      if (delMap.error) {
        console.error('[or-quiltt-disconnect] profile_map delete failed:', delMap.error.message);
      } else {
        profileMapDeleted = (delMap.count ?? 0) > 0;
      }
    }

    return jsonResponse(
      {
        ok: true,
        quiltt_disconnected:   quilttDisconnected,
        or_connection_deleted: orConnectionDeleted,
        inbox_events_voided:   inboxEventsVoided,
        profile_map_deleted:   profileMapDeleted,
      },
      200, cors,
    );
  } catch (e) {
    console.error('[or-quiltt-disconnect] fatal:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-quiltt-disconnect'));
