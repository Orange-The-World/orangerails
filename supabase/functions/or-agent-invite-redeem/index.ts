/**
 * or-agent-invite-redeem — agent CLI exchanges invitation for credentials.
 *
 * Session: 2026-05-19-ANVIL
 * See: docs/OrangeRails-Agent-Members.md
 * See: https://wiki.abascal.ca/doc/02-proposed-architecture-agent-as-employee-Ga7ngrjhkO
 *
 * Called by `npx @orangerails/mcp connect <invitation-token>` on the agent's
 * machine. Public endpoint — no prior auth, the invitation token IS the auth.
 *
 * POST body:
 *   {
 *     invitation_token: string  // 64-char hex, the raw token from mint
 *     identity_pubkey: string   // base64 Ed25519 public key (32 bytes raw)
 *     kem_pubkey: string        // base64 hybrid X25519+ML-KEM-768 public key
 *                               // (same format as user_vault_meta.kem_public_key)
 *   }
 *
 * Response 200:
 *   {
 *     agent_member_id: string
 *     owner_user_id: string     // the owner the agent now belongs to
 *     access_token: string      // Supabase JWT, signed with project secret
 *     expires_at: string        // ISO 8601, 1 hour from now (Decision 2)
 *     token_type: 'bearer'
 *   }
 *
 * The CLI then:
 *   1. Persists access_token + its own private keys to ~/.orange-rails/identity.json
 *   2. Writes the MCP server config snippet into the detected local client
 *   3. Reports success to the user
 *
 * Refresh: not in v1. When the access_token expires (1h), the CLI calls
 * or-agent-token-refresh (separate endpoint, comes with the MCP server
 * scaffold) using a signed nonce challenge over the agent's identity_pubkey.
 *
 * Atomicity: this endpoint does three things that must succeed together:
 *   1. Create the shadow auth.users row (via auth admin API)
 *   2. Atomic SQL: update agent_members + mark invitation redeemed
 *   3. Mint the first JWT
 *
 * If step 2 fails after step 1 succeeded, we delete the shadow user
 * (manual rollback). If step 3 fails we still have a working state.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { create as createJwt, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour, per Decision 2

interface RedeemBody {
  invitation_token?: string;
  identity_pubkey?: string;
  kem_pubkey?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isHex64(s: string): boolean {
  return /^[a-f0-9]{64}$/.test(s);
}

function isBase64ish(s: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(s) && s.length >= 40 && s.length <= 4096;
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
    console.error('[or-agent-invite-redeem] missing required env vars');
    return jsonResponse({ error: 'Server misconfigured' }, 500, cors);
  }

  let createdShadowUserId: string | null = null;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Parse + validate body
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as RedeemBody;

    if (!body.invitation_token || !isHex64(body.invitation_token)) {
      return jsonResponse(
        { error: 'invitation_token must be 64-char lowercase hex' },
        400,
        cors,
      );
    }
    if (!body.identity_pubkey || !isBase64ish(body.identity_pubkey)) {
      return jsonResponse({ error: 'identity_pubkey (base64) is required' }, 400, cors);
    }
    if (!body.kem_pubkey || !isBase64ish(body.kem_pubkey)) {
      return jsonResponse({ error: 'kem_pubkey (base64) is required' }, 400, cors);
    }

    // Hash the token and peek the invitation
    const tokenHash = await sha256Hex(body.invitation_token);
    const { data: peek, error: peekErr } = await admin.rpc('peek_agent_invitation', {
      p_token_hash: tokenHash,
    });
    if (peekErr) {
      console.error('[or-agent-invite-redeem] peek failed:', peekErr.message);
      return jsonResponse({ error: 'Invitation lookup failed' }, 500, cors);
    }
    const inv = Array.isArray(peek) ? peek[0] : peek;
    if (!inv?.invitation_id) {
      return jsonResponse({ error: 'Invitation invalid, expired, or already redeemed' }, 410, cors);
    }

    // Create the shadow auth.users row.
    const syntheticEmail = `agent-${inv.agent_member_id}@orangerails-agents.local`;
    const randomPassword = crypto.randomUUID() + crypto.randomUUID(); // never used for login
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password: randomPassword,
      email_confirm: true,
      user_metadata: {
        is_shadow_agent: true,
        agent_member_id: inv.agent_member_id,
        owner_user_id: inv.owner_user_id,
      },
    });
    if (createErr || !created?.user) {
      console.error('[or-agent-invite-redeem] createUser failed:', createErr?.message);
      return jsonResponse({ error: 'Failed to create shadow user' }, 500, cors);
    }
    createdShadowUserId = created.user.id;

    // Atomic redemption: update agent_members + mark invitation redeemed
    const { data: completed, error: completeErr } = await admin.rpc('complete_agent_invitation', {
      p_invitation_id: inv.invitation_id,
      p_shadow_user_id: createdShadowUserId,
      p_identity_pubkey: body.identity_pubkey,
      p_kem_pubkey: body.kem_pubkey,
    });
    if (completeErr) {
      console.error('[or-agent-invite-redeem] complete_agent_invitation failed:', completeErr.message);
      // Roll back the shadow user creation
      await admin.auth.admin.deleteUser(createdShadowUserId);
      createdShadowUserId = null;
      return jsonResponse({ error: completeErr.message }, 409, cors);
    }
    const completedRow = Array.isArray(completed) ? completed[0] : completed;
    if (!completedRow?.agent_member_id) {
      await admin.auth.admin.deleteUser(createdShadowUserId);
      createdShadowUserId = null;
      return jsonResponse({ error: 'Redemption did not return a result' }, 500, cors);
    }

    // Mint a Supabase-compatible JWT for the shadow user.
    const now = Math.floor(Date.now() / 1000);
    const expiresUnix = now + ACCESS_TOKEN_TTL_SECONDS;
    const keyBuf = new TextEncoder().encode(jwtSecret);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBuf,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    const jwt = await createJwt(
      { alg: 'HS256', typ: 'JWT' },
      {
        aud: 'authenticated',
        exp: getNumericDate(expiresUnix - now),
        iat: now,
        iss: supabaseUrl + '/auth/v1',
        sub: createdShadowUserId,
        role: 'authenticated',
        email: syntheticEmail,
        app_metadata: { provider: 'or-agent-invite' },
        user_metadata: {
          is_shadow_agent: true,
          agent_member_id: completedRow.agent_member_id,
          owner_user_id: completedRow.owner_user_id,
        },
      },
      cryptoKey,
    );

    return jsonResponse(
      {
        agent_member_id: completedRow.agent_member_id as string,
        owner_user_id: completedRow.owner_user_id as string,
        access_token: jwt,
        expires_at: new Date(expiresUnix * 1000).toISOString(),
        token_type: 'bearer',
      },
      200,
      cors,
    );
  } catch (e) {
    // Safety net rollback
    if (createdShadowUserId) {
      try {
        await admin.auth.admin.deleteUser(createdShadowUserId);
      } catch (cleanupErr) {
        console.error(
          '[or-agent-invite-redeem] rollback delete failed:',
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      }
    }
    console.error('[or-agent-invite-redeem] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
