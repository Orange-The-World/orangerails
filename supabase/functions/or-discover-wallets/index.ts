/**
 * or-discover-wallets , list a connection's available wallets from the upstream provider.
 *
 * Pure pass-through: decrypts the connection's stored credentials in memory
 * using the caller-supplied ORK, delegates to the registered ProviderAdapter
 * for the connection's provider_type, and returns the plaintext discovery
 * result. The server NEVER stores discovered wallets , storage happens via
 * or-source-wallets-set after the user picks.
 *
 * Auth: same dual-mode as or-sync (X-Platform-API-Key OR Supabase JWT).
 *
 * POST body:
 *   subaccount_id?:   uuid    required in platform mode
 *   connection_id:    uuid    the connection to discover wallets for
 *   credentials_key:  string  base64 ORK (in-transit only, used in memory then discarded)
 *
 * Response:
 *   { discovered_wallets: [{ external_wallet_id, currency, label? }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { getProvider, parseCredentials } from '../_shared/providers/dispatch.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

// ─── AES-256-GCM helpers (kept inline for edge-fn isolation) ────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

// ─── Main handler ───────────────────────────────────────────────────────────

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

    if (!body.connection_id || typeof body.connection_id !== 'string') {
      return jsonResponse({ error: 'connection_id required' }, 400, cors);
    }
    if (!body.credentials_key || typeof body.credentials_key !== 'string') {
      return jsonResponse({ error: 'credentials_key required (base64 ORK)' }, 400, cors);
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    // Verify caller owns the connection (subaccount join enforces ownership in
    // both direct and platform modes).
    const { data: conn, error: connErr } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_credentials, subaccount_id')
      .eq('id', body.connection_id)
      .eq('subaccount_id', subaccountId)
      .maybeSingle();

    if (connErr) {
      console.error('[or-discover-wallets] connection lookup failed:', connErr);
      return jsonResponse({ error: 'Connection lookup failed' }, 500, cors);
    }
    if (!conn) return jsonResponse({ error: 'Connection not found' }, 404, cors);

    const adapter = getProvider(conn.provider_type as string);
    if (!adapter) {
      return jsonResponse({ error: `Unknown provider: ${conn.provider_type}` }, 400, cors);
    }

    // Decrypt credentials in memory only; never persisted.
    const credsKey = await importAesKey(body.credentials_key);
    const credsJson = await decryptAes(conn.encrypted_credentials as string, credsKey);
    const credentials = parseCredentials(adapter, credsJson);

    const discovered = await adapter.discoverWallets(credentials);

    return jsonResponse({ discovered_wallets: discovered }, 200, cors);
  } catch (err) {
    console.error('[or-discover-wallets] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-discover-wallets'));
