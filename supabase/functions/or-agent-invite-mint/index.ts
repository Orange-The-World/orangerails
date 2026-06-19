/**
 * or-agent-invite-mint , create an agent invitation, return one-time token.
 *
 * Session: 2026-05-19-ANVIL
 * See: docs/OrangeRails-Agent-Members.md
 *
 * Auth: Supabase user JWT (owner must be logged in).
 *
 * POST body:
 *   {
 *     agent_name: string    // "Claude on user's laptop"
 *     agent_kind: 'claude_code' | 'claude_desktop' | 'chatgpt' | 'cursor' | 'continue' | 'cline' | 'custom'
 *     role?: 'read_only' | 'bookkeeper' | 'accountant' | 'owner'  // default: 'bookkeeper'
 *   }
 *
 * Response 200:
 *   {
 *     agent_member_id: string
 *     invitation_token: string  // 64-char hex, shown to user ONCE
 *     expires_at: string        // ISO 8601, 7 days from now
 *   }
 *
 * The raw invitation_token is returned to the owner and never stored
 * server-side. Only its SHA-256 hash is stored in agent_invitation_tokens.
 *
 * The owner takes this token to the agent's machine (Claude Code terminal):
 *   npx @orangerails/mcp connect <invitation-token>
 *
 * The CLI calls or-agent-invite-redeem to complete the setup.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

type AgentKind =
  | 'claude_code'
  | 'claude_desktop'
  | 'chatgpt'
  | 'cursor'
  | 'continue'
  | 'cline'
  | 'custom';

type AgentRole = 'read_only' | 'bookkeeper' | 'accountant' | 'owner';

const VALID_KINDS: ReadonlySet<AgentKind> = new Set([
  'claude_code',
  'claude_desktop',
  'chatgpt',
  'cursor',
  'continue',
  'cline',
  'custom',
]);

const VALID_ROLES: ReadonlySet<AgentRole> = new Set([
  'read_only',
  'bookkeeper',
  'accountant',
  'owner',
]);

interface MintBody {
  agent_name?: string;
  agent_kind?: AgentKind;
  role?: AgentRole;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomTokenHex(): string {
  // 256-bit random, hex-encoded (64 chars).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    // Supabase user JWT auth: extract from Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Authorization: Bearer <user-jwt> required' }, 401, cors);
    }
    const userJwt = authHeader.slice(7);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      console.error('[or-agent-invite-mint] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      return jsonResponse({ error: 'Server misconfigured' }, 500, cors);
    }

    // Use a client authed as the calling user, so auth.uid() inside the SQL
    // function resolves to the owner. The function is SECURITY DEFINER but
    // reads auth.uid() to determine the owner.
    const userClient = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Read body
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as MintBody;

    // Validate
    if (!body.agent_name || typeof body.agent_name !== 'string') {
      return jsonResponse({ error: 'agent_name (string) is required' }, 400, cors);
    }
    if (body.agent_name.length > 100) {
      return jsonResponse({ error: 'agent_name too long (max 100 chars)' }, 400, cors);
    }
    if (!body.agent_kind || !VALID_KINDS.has(body.agent_kind)) {
      return jsonResponse(
        { error: `agent_kind must be one of: ${Array.from(VALID_KINDS).join(', ')}` },
        400,
        cors,
      );
    }
    const role: AgentRole = body.role ?? 'bookkeeper';
    if (!VALID_ROLES.has(role)) {
      return jsonResponse(
        { error: `role must be one of: ${Array.from(VALID_ROLES).join(', ')}` },
        400,
        cors,
      );
    }

    // Generate raw token + hash. Raw token returned to user; only hash stored.
    const rawToken = randomTokenHex();
    const tokenHash = await sha256Hex(rawToken);

    // Collect optional metadata
    const fwdIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const ua = req.headers.get('user-agent') ?? null;

    // Atomic mint via SQL function
    const { data, error } = await userClient.rpc('mint_agent_invitation', {
      p_agent_name: body.agent_name,
      p_agent_kind: body.agent_kind,
      p_role: role,
      p_token_hash: tokenHash,
      p_created_from_ip: fwdIp,
      p_created_from_ua: ua,
    });

    if (error) {
      console.error('[or-agent-invite-mint] mint_agent_invitation failed:', error.message);
      // Pass through user-friendly errors (rate limit, validation)
      const status = error.message?.includes('Unauthorized')
        ? 401
        : error.message?.includes('Too many')
          ? 429
          : 400;
      return jsonResponse({ error: error.message }, status, cors);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.agent_member_id) {
      return jsonResponse({ error: 'Mint returned no result' }, 500, cors);
    }

    return jsonResponse(
      {
        agent_member_id: row.agent_member_id as string,
        invitation_token: rawToken,
        expires_at: row.expires_at as string,
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-agent-invite-mint] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
