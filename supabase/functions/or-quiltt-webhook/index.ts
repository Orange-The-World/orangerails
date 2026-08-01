/**
 * or-quiltt-webhook , receive Quiltt push events.
 *
 * Quiltt posts events here per its webhook spec
 * (https://www.quiltt.dev/webhooks). Payload shape:
 *   {
 *     environment: { id, mode, name, metadata },
 *     eventTypes:  ["profile.created", "connection.synced.successful.initial", ...],
 *     events: [
 *       {
 *         id:        "evt_...",
 *         type:      "connection.synced.successful.initial",
 *         at:        "2026-06-01T12:34:56Z",      // event time
 *         profile:   { id: "p_...", uuid, metadata },
 *         record:    { id: "conn_..." | "p_..." | ... },
 *       },
 *       ...
 *     ]
 *   }
 *
 * Verification: per Quiltt docs
 *   Quiltt-Signature = base64(HMAC-SHA256(secret, "1" + timestamp + raw_body))
 *   Quiltt-Timestamp = Unix epoch seconds (must be within 5 minutes of now)
 *
 * The version prefix is literal "1" (one digit), not "v1". The timestamp
 * is a unix-seconds integer in a string, not ISO 8601. Both differ from
 * the original implementation written for #124 , see PR fix-quiltt-webhook-
 * signature-scheme.
 *
 * We're not allowed to follow up with a GraphQL pull right here , the
 * 20-second response budget would blow up on a historical sync. So we
 * enqueue each event into quiltt_webhook_inbox (idempotent on event.id)
 * and return 200 fast. The worker (or-quiltt-sync) drains the inbox
 * asynchronously.
 *
 * Routing, and why there are two resolution paths (DL-0465):
 *
 *   1. profile.id maps via quiltt_profile_map to (platform_id, subaccount_id).
 *      This is the authoritative path.
 *   2. If that lookup misses, fall back to profile.metadata.or_subaccount_id,
 *      which OR itself writes at profile creation and Quiltt echoes back on
 *      every event.
 *
 * Path 2 exists because path 1 alone was silently unrecoverable. When the
 * map row was absent the event was enqueued with NULL routing on the theory
 * that "the worker re-resolves on drain" , but the worker re-resolved by
 * running the identical quiltt_profile_map lookup, so an event that missed
 * once missed forever. In production that stranded 408 events, 360 of which
 * were carrying the correct subaccount id inside the payload we had just
 * stored. Attempt counters reached 11,495 on a query that could never
 * succeed.
 *
 * Trust boundary on path 2, stated rather than assumed: the metadata is
 * written by OR in or-link-complete and relayed by Quiltt over an
 * HMAC-verified request, so it is as trustworthy as our own link flow and no
 * more. We do not take platform_id from the payload. We look the subaccount
 * up and read platform_id off that row, so a metadata value naming a
 * subaccount which does not exist resolves to nothing rather than to
 * something wrong. Every fallback use is logged so the path is auditable.
 *
 * The routing itself lives in ./routing.ts, not here. This module calls
 * Deno.serve at import time, so anything importing it binds a port; keeping
 * buildRows/applyRouting next door is what lets routing.test.ts assert the
 * contract with no server, no database and no credential. The two database
 * lookups stay here, because they are the part that needs a client.
 *
 * Response semantics (Quiltt retries up to 20 times with exponential
 * backoff on non-2xx, per docs):
 *   200 , event accepted (new or already-known)
 *   400 , bad body
 *   401 , signature missing / fails verification / timestamp skew
 *   413 , body too large
 *   500 , DB failure (Quiltt will retry)
 *
 * Env vars:
 *   QUILTT_WEBHOOK_SECRET , Model A shared secret (per dashboard subscription)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY , standard
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { applyRouting, buildRows, type QuilttEventLike } from './routing.ts';

const MAX_BODY = 256 * 1024;             // 256KB , generous for batched events
const MAX_TS_SKEW_MS = 5 * 60 * 1000;    // ±5 minutes
const SIG_VERSION = '1';                  // literal "1", NOT "v1" , see https://www.quiltt.dev/webhooks

/**
 * The full event as Quiltt documents it. Only the fields routing.ts declares
 * are read; the rest are here so the stored payload shape stays documented
 * at the point where it enters the system.
 */
interface QuilttEvent extends QuilttEventLike {
  at?: unknown;            // Quiltt event time (ISO 8601), per spec
  timestamp?: unknown;     // legacy alias accepted in payload (some events use this name)
  record?: { id?: unknown };
  metadata?: unknown;
}

interface QuilttBody {
  eventTypes?: unknown;
  events?: unknown;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const sigHeader = req.headers.get('Quiltt-Signature') ?? req.headers.get('quiltt-signature');
    const tsHeader  = req.headers.get('Quiltt-Timestamp') ?? req.headers.get('quiltt-timestamp');
    if (!sigHeader || !tsHeader) {
      return new Response('missing signature headers', { status: 401 });
    }

    // Quiltt-Timestamp is unix epoch SECONDS (integer string), not ISO 8601.
    const tsSeconds = Number.parseInt(tsHeader, 10);
    if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) {
      return new Response('bad timestamp', { status: 401 });
    }
    if (Math.abs(Date.now() - tsSeconds * 1000) > MAX_TS_SKEW_MS) {
      return new Response('timestamp skew', { status: 401 });
    }

    const body = await req.text();
    if (body.length > MAX_BODY) {
      return new Response('payload too large', { status: 413 });
    }

    const secret = Deno.env.get('QUILTT_WEBHOOK_SECRET');
    if (!secret || secret.startsWith('placeholder')) {
      console.error('[or-quiltt-webhook] QUILTT_WEBHOOK_SECRET unset or placeholder');
      return new Response('webhook not configured', { status: 503 });
    }

    // Quiltt's signing payload is the literal version "1" + timestamp + raw body.
    const expected = await computeHmacB64(secret, `${SIG_VERSION}${tsHeader}${body}`);
    if (!timingSafeEqual(expected, sigHeader)) {
      return new Response('bad signature', { status: 401 });
    }

    let parsed: QuilttBody;
    try {
      parsed = JSON.parse(body) as QuilttBody;
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!parsed.events || !Array.isArray(parsed.events) || parsed.events.length === 0) {
      // Accept empty event batches as 200 (Quiltt sends them rarely; no-op).
      return new Response('ok (empty)', { status: 200 });
    }

    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // rows[i] and hints[i] describe the same event by construction. Malformed
    // events are dropped inside buildRows, and the hint travels on the row
    // rather than being recomputed from an index into a differently-filtered
    // array. See routing.ts for what that used to cost.
    const { rows, hints, profileIds, metaSubaccountIds } = buildRows(
      parsed.events as QuilttEvent[],
    );

    if (rows.length === 0) {
      return new Response('ok (no valid events)', { status: 200 });
    }

    // Path 1: bulk-resolve via quiltt_profile_map (authoritative).
    const mapping = new Map<string, { platform_id: string; subaccount_id: string }>();
    if (profileIds.length > 0) {
      const { data, error } = await client
        .from('quiltt_profile_map')
        .select('quiltt_profile_id, platform_id, subaccount_id')
        .in('quiltt_profile_id', profileIds);
      if (error) {
        console.error('[or-quiltt-webhook] map lookup failed:', error.message);
        // Still proceed , the metadata fallback and the worker both get a turn.
      } else if (data) {
        for (const row of data) {
          mapping.set(row.quiltt_profile_id, {
            platform_id:   row.platform_id,
            subaccount_id: row.subaccount_id,
          });
        }
      }
    }

    // Path 2: bulk-validate any subaccount ids carried in profile metadata.
    // platform_id comes off the subaccount row, never off the payload, so an
    // id naming a subaccount that does not exist resolves to nothing.
    const metaResolved = new Map<string, string>();   // subaccount_id -> platform_id
    if (metaSubaccountIds.length > 0) {
      const { data, error } = await client
        .from('subaccounts')
        .select('id, platform_id')
        .in('id', metaSubaccountIds);
      if (error) {
        console.error('[or-quiltt-webhook] subaccount validation failed:', error.message);
      } else if (data) {
        for (const row of data) metaResolved.set(row.id, row.platform_id);
      }
    }

    const { viaMap, viaMetadata, unrouted } = applyRouting(rows, hints, mapping, metaResolved);

    if (viaMetadata > 0 || unrouted > 0) {
      // One line per batch, not per event: this is the signal that
      // quiltt_profile_map is drifting from reality, and it has to be
      // findable without reading three thousand log lines.
      console.warn(
        `[or-quiltt-webhook] routing: ${viaMap} via profile map, ` +
          `${viaMetadata} via profile metadata fallback, ${unrouted} unrouted ` +
          `(of ${rows.length} events)`,
      );
    }

    // Idempotent insert. ON CONFLICT DO NOTHING on event_id PK means
    // Quiltt's retries (up to 20×) don't double-process.
    const { error: insertErr } = await client
      .from('quiltt_webhook_inbox')
      .upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true });

    if (insertErr) {
      console.error('[or-quiltt-webhook] inbox insert failed:', insertErr.message);
      return new Response('inbox insert failed', { status: 500 });
    }

    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('[or-quiltt-webhook] error:', e instanceof Error ? e.message : String(e));
    return new Response('internal error', { status: 500 });
  }
}, 'or-quiltt-webhook'));

async function computeHmacB64(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
