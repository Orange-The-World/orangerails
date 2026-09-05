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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
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
    if (!sig) {
      console.warn('[or-strike-webhook] missing-sig 401: conn=%s', connId);
      return new Response('missing signature', { status: 401 });
    }

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
      .select('id, strike_webhook_secret, provider_type, strike_bad_sig_count')
      .eq('id', connId)
      .maybeSingle();

    if (lookupErr) {
      console.error('[or-strike-webhook] connection lookup failed:', lookupErr);
      return new Response('lookup failed', { status: 500 });
    }
    if (!conn || !conn.strike_webhook_secret || conn.provider_type !== 'strike') {
      // Don't leak "no such connection" vs "wrong provider" , both 401.
      console.warn('[or-strike-webhook] unknown-conn 401: found=%s has_secret=%s provider=%s id=%s',
        !!conn, !!(conn?.strike_webhook_secret), conn?.provider_type ?? 'n/a', connId);
      return new Response('unknown connection', { status: 401 });
    }

    const expected = await computeHmacHex(conn.strike_webhook_secret, body);
    if (!timingSafeEqual(expected, sig)) {
      console.warn('[or-strike-webhook] bad-sig 401: conn=%s sig_len=%s expected_len=%s', connId, sig.length, expected.length);
      await recordBadSig(client, connId);
      return new Response('bad signature', { status: 401 });
    }
    // A correctly verified delivery proves the stored secret is still
    // right, so any run of prior failures no longer means anything.
    if (conn.strike_bad_sig_count) {
      await clearBadSig(client, connId);
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

// ─── Subscription reconcile (OR-T0386) ────────────────────────────────────
//
// A stored subscription id does not mean it still verifies: the secret on
// the connection row can drift from the secret Strike actually signs with,
// and the registration path in queue.ts only ever fires once (when there is
// no subscription id yet). These two helpers are how a connection recovers:
// count consecutive bad-sig failures, and once they cross the threshold,
// flag the connection so the next user-initiated sync deletes the stale
// Strike subscription and registers a fresh one with a new secret.
//
// Both are best-effort. A failure here must never change the 401 the caller
// (Strike) gets, so every error is caught and logged, never thrown.
const STRIKE_BAD_SIG_THRESHOLD = 3;

async function recordBadSig(
  client: ReturnType<typeof createClient>,
  connId: string,
): Promise<void> {
  // strike_bump_bad_sig does the read and the write as one UPDATE, so two
  // bad-sig deliveries for the same connection arriving close together each
  // see the row as it is at the moment they run, never a count read here and
  // then staled by the other. It returns true only on the delivery that
  // actually crosses the threshold (OR-T2248).
  try {
    const { data: crossed, error } = await client.rpc('strike_bump_bad_sig', {
      p_conn_id: connId,
      p_threshold: STRIKE_BAD_SIG_THRESHOLD,
    });
    if (error) throw error;
    if (crossed) {
      console.warn(
        `[or-strike-webhook] conn=${connId} crossed bad-sig threshold (${STRIKE_BAD_SIG_THRESHOLD}), flagged for resubscribe`,
      );
    }
  } catch (err) {
    console.error('[or-strike-webhook] recordBadSig failed:', err);
  }
}

async function clearBadSig(client: ReturnType<typeof createClient>, connId: string): Promise<void> {
  try {
    await client.from('connections').update({ strike_bad_sig_count: 0 }).eq('id', connId);
  } catch (err) {
    console.error('[or-strike-webhook] clearBadSig failed:', err);
  }
}
