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
 * unreachable or not answering within GOTRUE_DEADLINE_MS (fail closed). A hung
 * auth service therefore ends in a fast 401 instead of tying up the function
 * worker (OR-T0421 step 5).
 *
 * This does not depend on the platform verify_jwt setting for the function.
 *
 * The claims decoded below come from the token payload without a signature
 * check. GoTrue accepting the token proves the token is genuine, not that the
 * claim values are true: they come from user_metadata, which is normally
 * writable by the user it belongs to. See extractAgentClaims.
 */

/**
 * How long the GoTrue check may take. Past this the call is aborted and the
 * request is refused with 401, the same outcome as GoTrue being unreachable.
 */
const GOTRUE_DEADLINE_MS = 200;

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
  // Treat these claims as unverified input. GoTrue accepting the token proves
  // the token is genuine, not that user_metadata values are true: that field
  // is normally writable by the user it belongs to. They are echo-only today
  // (orca.ping returns them and decides nothing). Any tool that authorizes on
  // ownership or membership must read it from a server-side table or from
  // app_metadata.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOTRUE_DEADLINE_MS);
  try {
    const res = await doFetch(`${deps.supabaseUrl}/auth/v1/user`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: deps.anonKey || jwt
      }
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 429) console.warn('or-mcp auth: GoTrue rate limited the token check (429)');
    return res.status === 200;
  } catch {
    // Unreachable, or aborted at the deadline: both refuse. Say which, so a
    // slow auth service shows in the function logs instead of as bare 401s.
    if (controller.signal.aborted) console.warn(`or-mcp auth: GoTrue did not answer within ${GOTRUE_DEADLINE_MS} ms`);
    return false;
  } finally {
    clearTimeout(timer);
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
