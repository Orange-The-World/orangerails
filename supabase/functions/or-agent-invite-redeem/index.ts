/**
 * or-agent-invite-redeem, Supabase Deno Edge Function.
 *
 * Redeems an agent invitation: validates the raw token, creates the shadow auth user, and
 * binds the invitee's identity_pubkey and kem_pubkey to the agent member. One request in,
 * one activated agent member out.
 *
 * WHY THIS FUNCTION EXISTS AT ALL
 * On the hosted Supabase projects anon holds no EXECUTE on complete_agent_invitation and
 * has not since migration 20260721120000. It was ruled that it must not be granted one
 * back: that function decides which public keys become a valid key wrap recipient for an
 * agent, and it is not a thing to make anonymously callable. The caller here is
 * service_role. The invitee has no session at redemption time, so something has to stand
 * in front of the rpc, and this is it. The May 2026 migration that created the two
 * functions already named "the or-agent-invite-redeem edge function" as their caller.
 *
 * WHAT IT DOES NOT DO. It does not make redemption non public. A pre-auth endpoint is
 * reachable by anyone on the internet whether the gateway JWT check is off or it merely
 * accepts the anon key, which ships in every browser bundle. The raw token remains the only
 * thing between a caller and a key binding. The honest claim is one controlled path we own
 * and can instrument. Rate limiting is wanted and is not here yet; the single entry point
 * is the seam it will attach to.
 *
 * POST only, and the token travels in the BODY. Never in the path, never in the query
 * string: those are logged by every hop in between, and the token is a bearer credential.
 *
 * Request  { token, identity_pubkey, kem_pubkey }
 * Response 200 { agent_member_id, shadow_user_id }
 * Response 400 { error: "invitation_not_redeemable" } for every rejection, identically.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { buildPublicCorsHeaders, readBoundedText } from "../_shared/http.ts";
import { wrapSentryHandler } from "../_shared/sentry.ts";
import {
  COMPLETE_RPC,
  FAILURE_BODY,
  FAILURE_STATUS,
  parseRedeemBody,
  PEEK_RPC,
  redeem,
  type RedeemPorts,
  type RedeemRequest,
  type Stage,
} from "./redeem.ts";

/** Requests carry three short fields. 8 KB is generous and keeps a garbage body cheap. */
const MAX_BODY_BYTES = 8_192;

/**
 * The shadow user's address. `.invalid` is reserved by RFC 2606 and can never resolve, which
 * is exactly right for a principal that must never receive mail. The local part is random,
 * not derived from the agent member: a derived address would be permanently occupied by an
 * orphan if a worker died between creating the user and binding it, and would then brick
 * every later retry for that agent.
 */
function shadowEmail(): string {
  return `agent-${crypto.randomUUID()}@agents.invalid`;
}

// deno-lint-ignore no-explicit-any
type ServiceClient = any;

function buildPorts(admin: ServiceClient): RedeemPorts {
  return {
    async peekInvitation(token: string): Promise<string | null> {
      const { data, error } = await admin.rpc(PEEK_RPC, { p_token: token });
      if (error) return null;
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      const id = rows[0]?.agent_member_id;
      return typeof id === "string" ? id : null;
    },

    async createShadowUser(): Promise<string | null> {
      // The password is generated here, used by nobody, and never leaves this scope. The
      // shadow user exists to be a stable principal id for row level security and for
      // wrapped_data_keys.recipient_user_id, not to be signed into from a browser.
      const { data, error } = await admin.auth.admin.createUser({
        email: shadowEmail(),
        password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        email_confirm: true,
        user_metadata: { kind: "agent-shadow" },
      });
      if (error) return null;
      const id = data?.user?.id;
      return typeof id === "string" ? id : null;
    },

    async deleteShadowUser(userId: string): Promise<void> {
      // Best effort. If this fails the row is an unbound auth user with no credential
      // anyone holds, which is inert; it is still worth cleaning up and worth sweeping
      // for later.
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch {
        /* ignore */
      }
    },

    async completeInvitation(
      input: RedeemRequest & { shadowUserId: string },
    ): Promise<boolean> {
      const { data, error } = await admin.rpc(COMPLETE_RPC, {
        p_token: input.token,
        p_shadow_user_id: input.shadowUserId,
        p_identity_pubkey: input.identityPubkey,
        p_kem_pubkey: input.kemPubkey,
      });
      // The error is deliberately swallowed rather than logged or re-thrown. A database
      // error string is the one place the token could plausibly come back to us, and
      // anything thrown from here reaches the error reporter. See the note on Stage.
      if (error) return false;
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return rows.length > 0;
    },

    note(stage: Stage): void {
      // A fixed vocabulary. No caller input is ever interpolated into a log line.
      console.log(`[or-agent-invite-redeem] ${stage}`);
    },
  };
}

function send(status: number, body: string, cors: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildPublicCorsHeaders();
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return send(405, JSON.stringify({ error: "method_not_allowed" }), cors);
  }

  const raw = await readBoundedText(req, MAX_BODY_BYTES);
  if (raw === null) {
    // Size is a property of the request, not of any invitation, so it is safe to answer
    // separately. It says nothing about whether a token exists.
    return send(413, JSON.stringify({ error: "request_too_large" }), cors);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const outcome = await redeem(parseRedeemBody(raw), buildPorts(admin));
    return send(outcome.status, outcome.body, cors);
  } catch {
    // Nothing is logged and nothing is re-thrown, because a caught value here may carry
    // upstream text. The response is the SAME rejection every other failure returns, so an
    // internal fault is not a signal either.
    return send(FAILURE_STATUS, FAILURE_BODY, cors);
  }
}, "or-agent-invite-redeem"));
