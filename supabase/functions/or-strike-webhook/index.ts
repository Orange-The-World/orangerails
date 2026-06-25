/**
 * or-strike-webhook , receive Strike webhook events.
 *
 * Strike posts skinny events here per docs.strike.me/webhooks. Payload shape:
 *   {
 *     id: "uuid",
 *     eventType: "invoice.updated",
 *     webhookVersion: "v1",
 *     data: { entityId: "<invoice-id>", changes: [...] },
 *     created: "2026-05-25T...",
 *     deliverySuccess: true
 *   }
 *
 * We don't have the customer's API key at receipt time (ZKA , key is
 * encrypted with vault password, only decryptable when user is present).
 * So we can't follow up with GET /v1/invoices/{id} right now. We queue
 * the event and let or-sync drain on the next user-initiated sync.
 *
 * URL: /functions/v1/or-strike-webhook?conn=<connection_id>
 * The connection_id is embedded at registration time so we can look up
 * the per-subscription webhook_secret for HMAC verification. Strike's
 * webhook payload itself does NOT carry our internal connection_id.
 *
 * Verification: HMAC-SHA256 hex of raw body, key = stored secret,
 * compared constant-time to X-Webhook-Signature header. Strike's
 * documented signature scheme (docs.strike.me/webhooks/signature-verification).
 *
 * Response semantics (Strike's docs say 5-second timeout, must 2xx fast):
 *   200 , event received (or already-known dedupe)
 *   400 , bad body / missing fields
 *   401 , missing/invalid signature or unknown connection
 *   405 , non-POST
 *   500 , DB failure (Strike will retry per their policy)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const CONN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StrikeWebhookEvent {
  id?: unknown;
  eventType?: unknown;
  data?: { entityId?: unknown };
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const url = new URL(req.url);
    const connId = url.searchParams.get('conn');
    if (!connId || !CONN_ID_RE.test(connId)) {
      return new Response('bad connection id', { status: 400 });
    }

    const sig = req.headers.get('X-Webhook-Signature');
    if (!sig) return new Response('missing signature', { status: 401 });

    // Read raw body for HMAC verification BEFORE parsing.
    const body = await req.text();
    if (body.length > 64 * 1024) {
      return new Response('payload too large', { status: 413 });
    }

    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: conn, error: lookupErr } = await client
      .from('connections')
      .select('id, strike_webhook_secret, provider_type')
      .eq('id', connId)
      .maybeSingle();

    if (lookupErr) {
      console.error('[or-strike-webhook] connection lookup failed:', lookupErr);
      return new Response('lookup failed', { status: 500 });
    }
    if (!conn || !conn.strike_webhook_secret || conn.provider_type !== 'strike') {
      // Don't leak "no such connection" vs "wrong provider" , both 401.
      return new Response('unknown connection', { status: 401 });
    }

    const expected = await computeHmacHex(conn.strike_webhook_secret, body);
    if (!timingSafeEqual(expected, sig)) {
      return new Response('bad signature', { status: 401 });
    }

    let event: StrikeWebhookEvent;
    try {
      event = JSON.parse(body) as StrikeWebhookEvent;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const eventId = typeof event.id === 'string' ? event.id : null;
    const eventType = typeof event.eventType === 'string' ? event.eventType : null;
    const entityId = typeof event.data?.entityId === 'string' ? event.data.entityId : null;
    if (!eventId || !eventType || !entityId) {
      return new Response('missing fields', { status: 400 });
    }

    // Idempotent upsert. Strike may retry; the UNIQUE(connection_id, strike_event_id)
    // constraint makes duplicates a no-op.
    const { error: insertErr } = await client.from('strike_webhook_events').upsert(
      {
        connection_id: connId,
        strike_event_id: eventId,
        event_type: eventType,
        entity_id: entityId,
      },
      { onConflict: 'connection_id,strike_event_id', ignoreDuplicates: true },
    );
    if (insertErr) {
      console.error('[or-strike-webhook] insert failed:', insertErr);
      return new Response('insert failed', { status: 500 });
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[or-strike-webhook] fatal:', err);
    return new Response('internal error', { status: 500 });
  }
}, 'or-strike-webhook'));

// ─── HMAC helpers ────────────────────────────────────────────────────────

async function computeHmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}
