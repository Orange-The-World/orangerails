// supabase/functions/client-verify-email/index.ts
//
// Magic-link landing handler. Verifies the signup token, creates the first
// application + API key for the org, and returns the raw key ONE TIME.
//
// POST /functions/v1/client-verify-email
// Body: { token: string }
// Returns: { ok: true, api_key: "orw_XXXX", org_id: "uuid", expires_never: true }
//   (the api_key is shown ONCE; key_hash is what's stored)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function randomKey(): string {
  // Format: orw_<60-hex-chars> (orange the world)
  const buf = new Uint8Array(30);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `orw_${hex}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const token = (body.token || "").trim();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return json({ error: "invalid_token" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Look up the signup token in audit_log (issued in client-signup)
  const { data: signupRow, error: lookupErr } = await supabase
    .schema("client_platform")
    .from("audit_log")
    .select("id, org_id, ts, actor_email, metadata")
    .eq("action", "signup.token_issued")
    .eq("target_id", token)
    .order("ts", { ascending: false })
    .limit(1)
    .single();

  if (lookupErr || !signupRow) return json({ error: "token_not_found" }, 404);

  // Reject if older than 24h
  const issuedAt = new Date(signupRow.ts).getTime();
  if (Date.now() - issuedAt > 24 * 60 * 60 * 1000) {
    return json({ error: "token_expired" }, 410);
  }

  // Idempotency: if an "signup.token_used" event already exists for this token, refuse
  const { data: used } = await supabase
    .schema("client_platform")
    .from("audit_log")
    .select("id")
    .eq("action", "signup.token_used")
    .eq("target_id", token)
    .limit(1)
    .maybeSingle();

  if (used) return json({ error: "token_already_used" }, 409);

  // Create the first application for this org
  const { data: app, error: appErr } = await supabase
    .schema("client_platform")
    .from("applications")
    .insert({ org_id: signupRow.org_id, name: "Default app" })
    .select()
    .single();

  if (appErr || !app) {
    console.error("app create failed", appErr);
    return json({ error: "app_create_failed" }, 500);
  }

  // Generate the API key
  const rawKey = randomKey();
  const keyHashHex = await sha256Hex(rawKey);
  const prefix = rawKey.slice(0, 12); // "orw_" + 8 hex = 12 chars

  const { error: keyErr } = await supabase
    .schema("client_platform")
    .from("api_keys")
    .insert({
      app_id: app.id,
      name: "Initial key",
      prefix,
      key_hash: keyHashHex,
      scopes: { truth: true, orbi: false, or: false },
    });

  if (keyErr) {
    console.error("key insert failed", keyErr);
    return json({ error: "key_create_failed" }, 500);
  }

  // Bridge: create Supabase auth user (auto-confirmed) + link as org owner.
  // This lets the same email log into app.orangerails.com via magic-link OTP.
  const email = signupRow.actor_email as string;
  const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name: signupRow.metadata?.name ?? null, source: "truth-signup" },
  });
  let authUserId: string | null = userData?.user?.id ?? null;
  if (userErr && !/already.*registered|exists/i.test(userErr.message)) {
    // Real error (not "user already exists" which is fine on re-signup)
    console.error("auth.admin.createUser failed", userErr);
  }
  // If user existed already, look them up
  if (!authUserId) {
    const { data: listData } = await supabase.auth.admin.listUsers();
    const found = listData?.users?.find((u) => u.email === email);
    authUserId = found?.id ?? null;
  }

  // Link auth user to org as owner (idempotent)
  if (authUserId) {
    await supabase
      .schema("client_platform")
      .from("organization_members")
      .upsert(
        { org_id: signupRow.org_id, user_id: authUserId, role: "owner" },
        { onConflict: "org_id,user_id", ignoreDuplicates: true }
      );
  }

  // Mark token as used
  await supabase
    .schema("client_platform")
    .from("audit_log")
    .insert({
      org_id: signupRow.org_id,
      actor_email: signupRow.actor_email,
      action: "signup.token_used",
      target_type: "signup_token",
      target_id: token,
      metadata: { auth_user_id: authUserId },
    });

  return json({
    ok: true,
    api_key: rawKey,                  // shown once, never again
    org_id: signupRow.org_id,
    app_id: app.id,
    expires_never: true,
    scopes: ["truth"],
  });
});
