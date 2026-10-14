/**
 * or-mcp request authentication (OR-T0421 step 3).
 *
 * Every JSON-RPC method (initialize, ping, tools/list, tools/call) must be
 * preceded by a successful token check. The check lives in this module and
 * not in index.ts because index.ts calls Deno.serve at import time and so
 * cannot be imported by a test.
 *
 * How it works: after the Authorization header is read, the bearer token is
 * sent to GoTrue (GET /auth/v1/user), once per request. GoTrue verifies the
 * signature and the expiry and confirms the user still exists, so a forged,
 * expired or revoked token gets a non-200 and the request is refused with
 * 401. Anything other than HTTP 200 is a refusal, including GoTrue being
 * unreachable (fail closed).
 *
 * This does not depend on the platform verify_jwt setting for the function.
 *
 * The claims decoded below come from the token payload without a signature
 * check, so they are only trusted once GoTrue has accepted the token.
 */

export type AgentClaims = {
  agent_member_id: string;
  owner_user_id: string;
  shadow_user_id: string;
  agent_role: string;
};

export type AuthDeps = {
  supabaseUrl: string;
  /** Project anon key for the apikey header. Falls back to the token itself. */
  anonKey?: string;
  /** Injected by tests. Defaults to the global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
};

export type AuthResult =
  | { ok: true; claims: AgentClaims }
  | { ok: false; status: 401; error: string };

function decodeJwtPayload(jwt: string) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - padded.length % 4) % 4;
    const decoded = atob(padded + '='.repeat(padLen));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractAgentClaims(jwt: string): AgentClaims | null {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;
  const userMeta = payload.user_metadata ?? {};
  if (!userMeta.is_shadow_agent) return null;
  const agentMemberId = userMeta.agent_member_id;
  const ownerUserId = userMeta.owner_user_id;
  const shadowUserId = payload.sub;
  const agentRole = userMeta.agent_role ?? 'bookkeeper';
  if (typeof agentMemberId !== 'string' || typeof ownerUserId !== 'string' || typeof shadowUserId !== 'string') {
    return null;
  }
  return {
    agent_member_id: agentMemberId,
    owner_user_id: ownerUserId,
    shadow_user_id: shadowUserId,
    agent_role: String(agentRole)
  };
}

async function gotrueAcceptsToken(jwt: string, deps: AuthDeps): Promise<boolean> {
  const doFetch: (url: string, init: RequestInit) => Promise<Response> =
    deps.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(`${deps.supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: deps.anonKey || jwt
      }
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Reads the Authorization header, checks the token shape, then asks GoTrue.
 * Never reads the request body, so it can run before any method is looked at.
 */
export async function authenticateRequest(req: Request, deps: AuthDeps): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Authorization: Bearer <jwt> required' };
  }
  const jwt = authHeader.slice(7);
  const claims = extractAgentClaims(jwt);
  if (!claims) {
    return { ok: false, status: 401, error: 'JWT is not a valid agent shadow-user token' };
  }
  if (!(await gotrueAcceptsToken(jwt, deps))) {
    return { ok: false, status: 401, error: 'Token validation failed' };
  }
  return { ok: true, claims };
}
