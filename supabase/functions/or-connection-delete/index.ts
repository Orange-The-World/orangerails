/**
 * or-connection-delete , delete a connection (and its transactions via cascade).
 *
 * For provider=strike connections with a registered webhook subscription,
 * also deletes the subscription on Strike's side if the caller provides the
 * unlock key. Without the unlock key OR cannot decrypt the API key, so the
 * subscription is left orphaned on Strike (subject to Strike's per-account
 * limit of 50 subscriptions). Best-effort cleanup either way , connection
 * row delete is the load-bearing step and always proceeds.
 *
 * POST body:
 *   subaccount_id?:   uuid    required in platform mode
 *   connection_id:    uuid    the connection to delete (must belong to subaccount)
 *   credentials_key?: base64  optional AES-256 unlock key for Strike sub teardown
 *
 * Response: { ok: true, strike_subscription_deleted?: boolean }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { strikeDeleteSubscription, parseStrikeCredentials } from '../_shared/providers/strike/index.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

// ─── AES helpers (mirror or-sync's pattern; will share once a util module lands) ─

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

// ─── Strike-specific best-effort cleanup ─────────────────────────────────

interface ConnectionRow {
  id: string;
  provider_type: string;
  encrypted_credentials: string;
  strike_subscription_id: string | null;
}

async function cleanupStrikeSubscription(
  conn: ConnectionRow,
  credentialsKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (conn.provider_type !== 'strike') return { ok: true, reason: 'not-strike' };
  if (!conn.strike_subscription_id) return { ok: true, reason: 'no-subscription' };

  try {
    const key = await importAesKey(credentialsKey);
    const credsJson = await decryptAes(conn.encrypted_credentials, key);
    const creds = parseStrikeCredentials(JSON.parse(credsJson));
    await strikeDeleteSubscription(creds, conn.strike_subscription_id);
    return { ok: true };
  } catch (err) {
    // Best-effort: if Strike returns 404, the subscription was already gone
    // (idempotent , strike.ts treats 404 as success for DELETEs). Any other
    // failure logs and we proceed with the row delete anyway.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[or-connection-delete] strike subscription cleanup failed for ${conn.id}: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 100) };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as {
      subaccount_id?: string;
      connection_id?: string;
      credentials_key?: string;
    };
    if (!body.connection_id) return jsonResponse({ error: 'connection_id required' }, 400, cors);

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    // Step 1: fetch the connection (need provider_type + strike_subscription_id
    // for the optional Strike webhook teardown).
    const { data: conn, error: fetchErr } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_credentials, strike_subscription_id')
      .eq('id', body.connection_id)
      .eq('subaccount_id', subaccountId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[or-connection-delete] fetch failed:', fetchErr);
      return jsonResponse({ error: 'Failed to look up connection' }, 500, cors);
    }
    if (!conn) {
      return jsonResponse({ error: 'Connection not found in this subaccount' }, 404, cors);
    }

    // Step 2: optionally clean up the Strike webhook subscription. Skipped
    // silently if the caller didn't pass credentials_key (older consumers).
    let strikeSubscriptionDeleted: boolean | undefined;
    if (body.credentials_key && conn.provider_type === 'strike' && conn.strike_subscription_id) {
      const result = await cleanupStrikeSubscription(conn as ConnectionRow, body.credentials_key);
      strikeSubscriptionDeleted = result.ok;
    }

    // Step 3: delete the OR connection row (cascades to transactions and the
    // strike_webhook_events queue via FK).
    const { error: delErr, count } = await ctx.serviceClient
      .from('connections')
      .delete({ count: 'exact' })
      .eq('id', body.connection_id)
      .eq('subaccount_id', subaccountId);

    if (delErr) {
      console.error('[or-connection-delete] delete failed:', delErr);
      return jsonResponse({ error: 'Failed to delete connection' }, 500, cors);
    }
    if ((count ?? 0) === 0) {
      return jsonResponse({ error: 'Connection not found in this subaccount' }, 404, cors);
    }

    const response: Record<string, unknown> = { ok: true };
    if (strikeSubscriptionDeleted !== undefined) {
      response.strike_subscription_deleted = strikeSubscriptionDeleted;
    }
    return jsonResponse(response, 200, cors);
  } catch (err) {
    console.error('[or-connection-delete] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-connection-delete'));
