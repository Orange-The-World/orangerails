/**
 * or-agent-revoke , owner revokes one of their AI agent members.
 *
 * Session: 2026-05-21-BIRCH
 *
 * Owner-only endpoint (authenticated via Supabase user JWT). On success:
 *   - agent_members.revoked_at is set
 *   - wrapped_data_keys rows for the agent's shadow user are deleted
 *   - all the shadow user's Supabase sessions are revoked
 *   - the shadow auth.users row is deleted entirely (irreversible cleanup)
 *   - an audit_entries row is written attributing the revocation
 *
 * POST body:
 *   {
 *     agent_member_id: string
 *     reason?: string
 *   }
 *
 * Response 200:
 *   {
 *     agent_member_id: string
 *     wrapped_keys_deleted: number
 *     shadow_user_deleted: boolean
 *     audit_entry_id: string | null
 *     was_already_revoked: boolean
 *   }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface RevokeBody {
  agent_member_id?: string;
  reason?: string;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('[or-agent-revoke] missing required env vars');
    return jsonResponse({ error: 'Server misconfigured' }, 500, cors);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Authorization: Bearer <user-jwt> required' }, 401, cors);
    }
    const userJwt = authHeader.slice(7);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as RevokeBody;

    if (!body.agent_member_id || !isUuid(body.agent_member_id)) {
      return jsonResponse({ error: 'agent_member_id (uuid) required' }, 400, cors);
    }
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
      return jsonResponse({ error: 'reason must be a string ≤500 chars' }, 400, cors);
    }

    // User-scoped client so auth.uid() in the SQL function resolves to the owner.
    const userClient = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: revokeResult, error: revokeErr } = await userClient.rpc('revoke_agent_member', {
      p_agent_member_id: body.agent_member_id,
      p_reason: body.reason ?? null,
    });
    if (revokeErr) {
      console.error('[or-agent-revoke] revoke failed:', revokeErr.message);
      const status = revokeErr.message?.includes('Unauthorized')
        ? 401
        : revokeErr.message?.includes('Forbidden')
          ? 403
          : revokeErr.message?.includes('not found')
            ? 404
            : 400;
      return jsonResponse({ error: revokeErr.message }, status, cors);
    }
    const row = Array.isArray(revokeResult) ? revokeResult[0] : revokeResult;
    if (!row?.agent_member_id) {
      return jsonResponse({ error: 'Revoke returned no result' }, 500, cors);
    }

    // Service-role client for the auth admin operation (delete shadow user).
    let shadowUserDeleted = false;
    if (row.shadow_user_id && !row.was_already_revoked) {
      const admin = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: deleteErr } = await admin.auth.admin.deleteUser(row.shadow_user_id as string);
      if (deleteErr) {
        // Non-fatal: the agent row is already marked revoked + wrapped_data_keys
        // deleted. The shadow user being left orphaned only prevents nothing
        // (no JWTs can be minted for it anyway because get_agent_pubkey_for_refresh
        // filters revoked agents). Log and continue.
        console.warn('[or-agent-revoke] failed to delete shadow user:', deleteErr.message);
      } else {
        shadowUserDeleted = true;
      }
    }

    return jsonResponse(
      {
        agent_member_id: row.agent_member_id as string,
        wrapped_keys_deleted: (row.wrapped_keys_deleted as number) ?? 0,
        shadow_user_deleted: shadowUserDeleted,
        audit_entry_id: (row.audit_entry_id as string | null) ?? null,
        was_already_revoked: Boolean(row.was_already_revoked),
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-agent-revoke] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-agent-revoke'));
