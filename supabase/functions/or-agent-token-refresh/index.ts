/**
 * or-agent-token-refresh — issue a fresh JWT to an agent that proves it still
 * holds its Ed25519 private key via a signed-payload challenge.
 *
 * Session: 2026-05-21-BIRCH (v2: appends audit entry on success)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { create as createJwt, getNumericDate } from 'jsr:@cmd-johnson/djwt@3';
import { ed25519 } from 'jsr:@noble/curves@1.6.0/ed25519';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const NONCE_WINDOW_SECONDS = 60;
const EXPECTED_PREFIX = 'or-agent-refresh';

interface RefreshBody {
  agent_member_id?: string;
  signed_payload?: string;
  signature?: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseAndValidatePayload(payload: string, agentMemberId: string):
  | { ok: true; tsMs: number }
  | { ok: false; reason: string } {
  const parts = payload.split('|');
  if (parts.length !== 3) return { ok: false, reason: 'signed_payload must be exactly 3 pipe-separated parts' };
  const [prefix, mid, ts] = parts;
  if (prefix !== EXPECTED_PREFIX) return { ok: false, reason: `signed_payload prefix must be "${EXPECTED_PREFIX}"` };
  if (mid !== agentMemberId) return { ok: false, reason: 'signed_payload agent_member_id does not match body' };
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return { ok: false, reason: 'signed_payload timestamp is not valid ISO 8601' };
  const drift = Math.abs(Date.now() - tsMs);
  if (drift > NONCE_WINDOW_SECONDS * 1000) {
    return { ok: false, reason: `signed_payload timestamp drifts ${Math.round(drift / 1000)}s from server (max ${NONCE_WINDOW_SECONDS}s)` };
  }
  return { ok: true, tsMs };
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET');
  if (!supabaseUrl || !serviceKey || !jwtSecret) {
    return jsonResponse({ error: 'Server misconfigured' }, 500, cors);
  }

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as RefreshBody;

    if (!body.agent_member_id || !isUuid(body.agent_member_id)) {
      return jsonResponse({ error: 'agent_member_id (uuid) required' }, 400, cors);
    }
    if (!body.signed_payload || typeof body.signed_payload !== 'string' || body.signed_payload.length > 256) {
      return jsonResponse({ error: 'signed_payload (string, <=256 chars) required' }, 400, cors);
    }
    if (!body.signature || typeof body.signature !== 'string') {
      return jsonResponse({ error: 'signature (base64) required' }, 400, cors);
    }

    const payloadCheck = parseAndValidatePayload(body.signed_payload, body.agent_member_id);
    if (!payloadCheck.ok) {
      return jsonResponse({ error: payloadCheck.reason }, 408, cors);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: lookup, error: lookupErr } = await admin.rpc('get_agent_pubkey_for_refresh', {
      p_agent_member_id: body.agent_member_id,
    });
    if (lookupErr) {
      console.error('[or-agent-token-refresh] lookup failed:', lookupErr.message);
      return jsonResponse({ error: 'Agent lookup failed' }, 500, cors);
    }
    const row = Array.isArray(lookup) ? lookup[0] : lookup;
    if (!row?.identity_pubkey || !row?.shadow_user_id) {
      return jsonResponse({ error: 'Agent not found, not activated, or revoked' }, 403, cors);
    }

    let signatureBytes: Uint8Array;
    let pubkeyBytes: Uint8Array;
    try {
      signatureBytes = base64ToBytes(body.signature);
      pubkeyBytes = base64ToBytes(row.identity_pubkey as string);
    } catch {
      return jsonResponse({ error: 'signature or stored pubkey is not valid base64' }, 400, cors);
    }
    if (signatureBytes.length !== 64) {
      return jsonResponse({ error: 'signature must be a 64-byte Ed25519 signature' }, 400, cors);
    }
    if (pubkeyBytes.length !== 32) {
      return jsonResponse({ error: 'Stored pubkey invalid' }, 500, cors);
    }

    const messageBytes = new TextEncoder().encode(body.signed_payload);
    const verified = ed25519.verify(signatureBytes, messageBytes, pubkeyBytes);
    if (!verified) {
      return jsonResponse({ error: 'Signature verification failed' }, 401, cors);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresUnix = now + ACCESS_TOKEN_TTL_SECONDS;
    const keyBuf = new TextEncoder().encode(jwtSecret);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const jwt = await createJwt(
      { alg: 'HS256', typ: 'JWT' },
      {
        aud: 'authenticated',
        exp: getNumericDate(expiresUnix - now),
        iat: now,
        iss: supabaseUrl + '/auth/v1',
        sub: row.shadow_user_id as string,
        role: 'authenticated',
        app_metadata: { provider: 'or-agent-refresh' },
        user_metadata: {
          is_shadow_agent: true,
          agent_member_id: body.agent_member_id,
          owner_user_id: row.owner_user_id,
          agent_role: row.agent_role,
        },
      },
      cryptoKey,
    );

    // Best-effort: bump activity + write audit entry. Neither failure
    // should fail the request (the JWT is already minted).
    await admin
      .rpc('touch_agent_activity', { p_agent_member_id: body.agent_member_id })
      .catch((e: unknown) => console.warn('[or-agent-token-refresh] touch failed:', String(e)));

    const fwdIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const ua = req.headers.get('user-agent') ?? null;
    await admin
      .rpc('log_agent_token_refresh', {
        p_agent_member_id: body.agent_member_id,
        p_shadow_user_id: row.shadow_user_id,
        p_client_ip: fwdIp,
        p_client_user_agent: ua,
      })
      .catch((e: unknown) => console.warn('[or-agent-token-refresh] audit log failed:', String(e)));

    return jsonResponse(
      {
        access_token: jwt,
        expires_at: new Date(expiresUnix * 1000).toISOString(),
        token_type: 'bearer',
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-agent-token-refresh] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
