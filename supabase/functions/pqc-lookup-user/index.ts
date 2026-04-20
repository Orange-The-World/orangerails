/**
 * pqc-lookup-user — resolve email → userId + kemPublicKey.
 *
 * Used by the co-admin grant flow so the owner can wrap their subkey blob
 * for a recipient without exposing any auth.users data directly to the client.
 *
 * Authorization: the caller must be authenticated (they are the owner doing
 * the grant). We verify their JWT before anything else.
 *
 * Scope boundary: returns ONLY { userId, kemPublicKey }. No email, display
 * name, or any other user metadata is ever returned.
 *
 * Returns 404 when:
 *   - No user with that email exists.
 *   - The target has not yet unlocked their vault (no PQC keys).
 *
 * The service-role client is needed to query auth.users by email. The
 * anon client is used solely for the caller's JWT check.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

  try {
    // Verify the caller is authenticated.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401, cors);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user: caller },
      error: authError,
    } = await anonClient.auth.getUser();
    if (authError || !caller) return jsonResponse({ error: "Unauthorized" }, 401, cors);

    // Parse and validate the request body.
    const raw = await readBoundedText(req, 4096);
    if (raw === null) return jsonResponse({ error: "Request body too large" }, 413, cors);

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400, cors);
    }
    const { email } = (body as Record<string, unknown>) ?? {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return jsonResponse({ error: "email required" }, 400, cors);
    }

    // Service-role client to query auth.users and user_vault_meta.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Look up the target user by email in auth.users.
    const { data: usersPage, error: listErr } = await serviceClient.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) {
      console.error("listUsers error:", listErr);
      return jsonResponse({ error: "Internal error" }, 500, cors);
    }

    const target = (usersPage?.users ?? []).find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (!target) return jsonResponse({ error: "User not found" }, 404, cors);

    // Prevent self-grant — a user cannot add themselves as a co-admin.
    if (target.id === caller.id) {
      return jsonResponse({ error: "Cannot add yourself as a co-admin" }, 400, cors);
    }

    // Fetch the target's PQC public key from user_vault_meta.
    const { data: meta, error: metaErr } = await serviceClient
      .from("user_vault_meta")
      .select("kem_public_key")
      .eq("user_id", target.id)
      .maybeSingle();

    if (metaErr) {
      console.error("vault meta query error:", metaErr);
      return jsonResponse({ error: "Internal error" }, 500, cors);
    }
    if (!meta?.kem_public_key) {
      return jsonResponse(
        { error: "Target user has not set up their vault yet" },
        404,
        cors,
      );
    }

    return jsonResponse(
      { userId: target.id, kemPublicKey: meta.kem_public_key },
      200,
      cors,
    );
  } catch (err) {
    console.error("pqc-lookup-user unhandled error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }
});
