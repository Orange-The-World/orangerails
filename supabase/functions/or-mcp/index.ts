/**
 * or-mcp — Streamable HTTP transport endpoint for MCP.
 *
 * Session: 2026-05-21-BIRCH
 *
 * Lets cloud agents (ChatGPT in browser, hosted MCP services) talk to
 * Orange Rails tools without running a local stdio process. Follows the
 * MCP "Streamable HTTP" transport pattern: client POSTs a JSON-RPC frame,
 * server responds with a Server-Sent Events stream containing the result.
 *
 * v0.1 of this endpoint is intentionally minimal:
 *   - Unidirectional (POST → SSE response, no server-initiated events)
 *   - Stateless (no session continuation; each POST is independent)
 *   - Supports tools/list, tools/call, ping methods
 *
 * Auth: Bearer JWT issued by or-agent-invite-redeem or or-agent-token-refresh.
 *
 * POST body:
 *   JSON-RPC 2.0 request, e.g.
 *     { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
 *     { "jsonrpc": "2.0", "id": 2, "method": "tools/call",
 *       "params": { "name": "books.ping", "arguments": {} } }
 *
 * Response:
 *   Content-Type: text/event-stream
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * Or 400/401/etc. for error states.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildCorsHeaders, readBoundedText } from '../_shared/http.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2025-11-25';

const TOOLS = [
  {
    name: 'books.ping',
    description:
      'Smoke check. Returns "pong" plus the calling agent member id and the server time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

interface AgentClaims {
  agent_member_id: string;
  owner_user_id: string;
  shadow_user_id: string;
  agent_role: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const decoded = atob(padded + '='.repeat(padLen));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAgentClaims(jwt: string): AgentClaims | null {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return null;
  const userMeta = (payload.user_metadata ?? {}) as Record<string, unknown>;
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
    agent_role: String(agentRole),
  };
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...extraHeaders,
    },
  });
}

function jsonResponse(payload: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  claims: AgentClaims,
  jwt: string,
  supabaseUrl: string,
): Promise<unknown> {
  if (toolName === 'books.ping') {
    // Validate the token by calling Supabase auth introspection, same as
    // the stdio path. Surfaces 401 if revoked.
    const introspect = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: jwt },
    });
    if (!introspect.ok) {
      throw new Error(`Token validation failed (HTTP ${introspect.status})`);
    }
    return {
      pong: true,
      agent_member_id: claims.agent_member_id,
      owner_user_id: claims.owner_user_id,
      agent_role: claims.agent_role,
      transport: 'http-sse',
      server_time: new Date().toISOString(),
    };
  }
  throw new Error(`Unknown tool: ${toolName}`);
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) {
    return jsonResponse({ error: 'Server misconfigured' }, 500, cors);
  }

  // Auth: Bearer JWT
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Authorization: Bearer <jwt> required' }, 401, cors);
  }
  const jwt = authHeader.slice(7);
  const claims = extractAgentClaims(jwt);
  if (!claims) {
    return jsonResponse({ error: 'JWT is not a valid agent shadow-user token' }, 401, cors);
  }

  // Body
  const raw = await readBoundedText(req);
  if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
  let rpc: JsonRpcRequest;
  try {
    rpc = JSON.parse(raw || '{}') as JsonRpcRequest;
  } catch {
    return jsonResponse({ error: 'Body must be valid JSON' }, 400, cors);
  }

  if (rpc.jsonrpc !== '2.0' || !rpc.method) {
    return jsonResponse({ error: 'Request must be JSON-RPC 2.0 with method' }, 400, cors);
  }

  const id = rpc.id ?? null;
  const response: JsonRpcResponse = { jsonrpc: '2.0', id };

  try {
    switch (rpc.method) {
      case 'initialize':
        response.result = {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: '@orangerails/mcp-http', version: '0.1.0' },
          capabilities: { tools: {} },
        };
        break;
      case 'ping':
        response.result = {};
        break;
      case 'tools/list':
        response.result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!params.name || typeof params.name !== 'string') {
          response.error = { code: -32602, message: 'tools/call requires params.name (string)' };
          break;
        }
        const toolResult = await handleToolCall(
          params.name,
          params.arguments ?? {},
          claims,
          jwt,
          supabaseUrl,
        );
        response.result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
        break;
      }
      default:
        response.error = { code: -32601, message: `Method not found: ${rpc.method}` };
    }
  } catch (e) {
    response.error = {
      code: -32603,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // Return as a Streamable HTTP SSE response
  return sseResponse(sseEvent(response) + 'event: done\ndata: {}\n\n', 200, cors);
});
