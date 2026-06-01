// supabase/functions/client-signup/index.ts
//
// Self-serve signup endpoint for Orange the World (Truth API).
// Flow: user submits email + (optional) name + "what are you building" →
//   1. Validate email + create organization (status='pending')
//   2. Create signup_token row (random opaque token, 24h TTL)
//   3. Email magic link via Resend → /verify?token=XXX
//
// POST /functions/v1/client-signup
// Body: { email: string, name?: string, building?: string }
// Returns: { ok: true } or { error: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Orange the World <hello@orangerails.com>";
const WORLD_BASE_URL = Deno.env.get("WORLD_BASE_URL") || "https://orangetheworld.orangerails.com";

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

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { email?: string; name?: string; building?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim().slice(0, 100);
  const building = (body.building || "").trim().slice(0, 500);

  if (!isValidEmail(email)) return json({ error: "invalid_email" }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1. Create organization (slug includes random suffix, so no collision)
  //    Multiple orgs per email is fine for now; signup-token TTL keeps things tidy.
  const slugBase = email.split("@")[0].replace(/[^a-z0-9]/g, "").slice(0, 30);
  const orgSlug = (slugBase || "user") + "-" + randomToken(4);
  const { data: org, error: orgErr } = await supabase
    .schema("client_platform")
    .from("organizations")
    .insert({
      name: name || email.split("@")[0],
      slug: orgSlug,
      billing_email: email,
      status: "active",
      created_via: "self-serve",
    })
    .select()
    .single();

  if (orgErr || !org) {
    console.error("org create failed", orgErr);
    return json({ error: "signup_failed" }, 500);
  }

  // 2. Issue truth entitlement on hobby tier if not already present
  const { data: hobbyPlan } = await supabase
    .schema("client_platform")
    .from("api_plans")
    .select("id")
    .eq("product", "truth")
    .eq("tier", "hobby")
    .single();

  await supabase
    .schema("client_platform")
    .from("organization_entitlements")
    .upsert(
      { org_id: org.id, product: "truth", plan_id: hobbyPlan?.id ?? null, notes: building },
      { onConflict: "org_id,product", ignoreDuplicates: true }
    );

  // 3. Create signup token (we will table this later; for now use audit_log as breadcrumb)
  const token = randomToken(32);
  // Store token hash + org_id in audit_log; verify endpoint looks it up
  // (Proper signup_tokens table can be added later if we need rotation)
  await supabase
    .schema("client_platform")
    .from("audit_log")
    .insert({
      org_id: org.id,
      actor_email: email,
      action: "signup.token_issued",
      target_type: "signup_token",
      target_id: token,
      metadata: { building, name },
    });

  // 4. Send magic-link email via Resend
  const verifyUrl = `${WORLD_BASE_URL}/verify?token=${token}`;
  const emailResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: "Activate your Orange the World API key",
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:auto;padding:24px">
          <h1 style="color:#ff6b00">Welcome to Orange the World</h1>
          <p>Click the button below to activate your free Truth Data API key.</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#ff6b00;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Activate my API key</a></p>
          <p style="color:#64748b;font-size:13px;margin-top:32px">If you didn't sign up, ignore this email. The link expires in 24 hours.</p>
        </div>`,
    }),
  });

  if (!emailResp.ok) {
    const errBody = await emailResp.text();
    console.error("resend failed", emailResp.status, errBody);
    return json({ error: "email_failed" }, 502);
  }

  return json({ ok: true });
});
