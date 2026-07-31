/**
 * or-quiltt-sync — drain quiltt_webhook_inbox, pull data from Quiltt
 * GraphQL, seal under each user's OPK, persist as encrypted_transactions.
 *
 * Trigger: HTTP POST (callable manually for testing; wire to supabase_cron
 * on a schedule later). One call processes a bounded batch of pending
 * events and returns metrics.
 *
 * Phase 1 scope:
 *   - Only events for subaccounts with opk_public set are processed
 *     here. Non-opted-in users get their Quiltt data on next active
 *     sync via the user-session path (separate change in or-sync).
 *   - Only connection.synced.successful.* events drive data pulls.
 *     Other events (profile.*, account.verified, errors) are marked
 *     processed without action; or wired into the dispatcher later.
 *
 * Auth: requires X-Internal-Worker-Token (constant-time compared to
 * OR_INTERNAL_WORKER_TOKEN env). This endpoint is for OR ops + cron
 * only; never callable from integrators or browsers.
 *
 * Env vars:
 *   QUILTT_API_KEY              — Model A master key
 *   OR_INTERNAL_WORKER_TOKEN    — caller auth for this endpoint
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — standard
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { OPK_SEAL_ALG, decodeOpkPublicKey, sealToOpk } from '../_shared/opk-seal.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const QUILTT_GRAPHQL = 'https://api.quiltt.io/v1/graphql';
const BATCH_SIZE = 20;        // events drained per invocation
const TX_PAGE_SIZE = 100;
// A row that fails its routing precondition on every attempt can never be
// processed, so it holds a BATCH_SIZE slot forever. After this many tries
// the row is retired to dead-letter state (processed_at set, last_error
// preserved) in the same UPDATE as the final attempt counter, so it cannot
// take another slot and the queue head always advances past it.
const MAX_ATTEMPTS = 25;
// 50 pages × 100 = 5,000 transactions per connection per webhook event.
// Covers most banks' full available history (Quiltt typically caps at ~2y).
// Still bounded so a hostile/buggy upstream can't burn unlimited time.
const MAX_PAGES = 50;

// Per-event wall-clock budget. A pathological profile (many bound
// connections, slow Quiltt responses, or hostile fanout) can otherwise
// exhaust the Supabase edge-runtime ~150s wall and starve the rest of
// the batch. Cap each event at 60s; if we run over, mark `partial` and
// let the next cron tick pick up the remainder.
const PER_EVENT_BUDGET_MS = 60_000;

// Quiltt PROD geo-blocks Canada (and other non-US) at the GraphQL
// layer. Supabase routes outbound through us-east-1 when this header
// is set, dodging the 403. Same trick OWM uses on its OR proxy calls.
const QUILTT_REGION_HEADER = 'us-east-1';

interface PendingEvent {
  event_id:      string;
  event_type:    string;
  payload:       any;
  platform_id:   string | null;
  subaccount_id: string | null;
  attempts:      number;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const callerToken = req.headers.get('X-Internal-Worker-Token');
  const expected = Deno.env.get('OR_INTERNAL_WORKER_TOKEN');
  if (!expected) return new Response('worker token not configured', { status: 503 });
  if (!callerToken || !timingSafeEqual(callerToken, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  const quilttApiKey = Deno.env.get('QUILTT_API_KEY');
  if (!quilttApiKey) return new Response('QUILTT_API_KEY missing', { status: 503 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let processed = 0;
  let failed    = 0;
  let skipped   = 0;

  // Pull a batch of pending events
  const { data: pending, error: pendErr } = await client
    .from('quiltt_webhook_inbox')
    .select('event_id, event_type, payload, platform_id, subaccount_id, attempts')
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (pendErr) {
    console.error('[or-quiltt-sync] inbox query failed:', pendErr.message);
    return jsonResponse({ error: 'inbox query failed' }, 500);
  }
  if (!pending || pending.length === 0) {
    return jsonResponse({ processed: 0, failed: 0, skipped: 0, message: 'inbox empty' }, 200);
  }

  for (const ev of pending as PendingEvent[]) {
    try {
      // Re-resolve routing if missing (link-race tolerance).
      //
      // Two sources, in order of authority. The second one is the point:
      // this block used to try quiltt_profile_map ONLY, which is the same
      // lookup or-quiltt-webhook already ran when it wrote NULL in the first
      // place. Re-running an identical query against unchanged data returns
      // the identical miss, so an event that missed once missed on every
      // tick forever. That is not link-race tolerance, it is a loop, and in
      // production it ran attempt counters past 11,000 while the answer sat
      // unread in the payload beside it (DL-0465).
      //
      // Nothing here trusts the payload for platform_id. The subaccount row
      // is looked up and platform_id read off it, so a metadata value naming
      // a subaccount that does not exist stays unresolved.
      let { platform_id, subaccount_id } = ev;
      if (!subaccount_id) {
        const profileId = ev.payload?.profile?.id;
        if (typeof profileId === 'string') {
          const m = await client
            .from('quiltt_profile_map')
            .select('platform_id, subaccount_id')
            .eq('quiltt_profile_id', profileId)
            .maybeSingle();
          if (m.data) {
            platform_id   = m.data.platform_id;
            subaccount_id = m.data.subaccount_id;
          }
        }

        if (!subaccount_id) {
          const metaSub = ev.payload?.profile?.metadata?.or_subaccount_id;
          if (typeof metaSub === 'string' && metaSub.length > 0) {
            const s = await client
              .from('subaccounts')
              .select('id, platform_id')
              .eq('id', metaSub)
              .maybeSingle();
            if (s.data) {
              platform_id   = s.data.platform_id;
              subaccount_id = s.data.id;
              console.warn(
                `[or-quiltt-sync] event ${ev.event_id}: routed via profile metadata ` +
                  `after quiltt_profile_map missed (profile ${typeof profileId === 'string' ? profileId : 'unknown'})`,
              );
            }
          }
        }

        if (subaccount_id && platform_id) {
          await client
            .from('quiltt_webhook_inbox')
            .update({ platform_id, subaccount_id })
            .eq('event_id', ev.event_id);
        }
      }
      if (!subaccount_id || !platform_id) {
        // Still no mapping; mark attempted but not processed (try next cycle)
        await bumpAttempts(client, ev, 'mapping-missing');
        skipped++;
        continue;
      }

      const handled = await handleEvent(client, ev, platform_id, subaccount_id, quilttApiKey);
      if (handled === 'processed') {
        await markProcessed(client, ev.event_id);
        processed++;
      } else if (handled === 'skipped') {
        await markProcessed(client, ev.event_id);  // no-op events still mark done
        skipped++;
      } else {
        await bumpAttempts(client, ev, handled);
        failed++;
      }
    } catch (e) {
      console.error(`[or-quiltt-sync] event ${ev.event_id} threw:`, e instanceof Error ? e.message : String(e));
      await bumpAttempts(client, ev, e instanceof Error ? e.message : String(e));
      failed++;
    }
  }

  return jsonResponse({ processed, failed, skipped, batch: pending.length }, 200);
}, 'or-quiltt-sync'));

// ─── event dispatch ──────────────────────────────────────────────────

async function handleEvent(
  client: SupabaseClient,
  ev: PendingEvent,
  platformId: string,
  subaccountId: string,
  apiKey: string,
): Promise<'processed' | 'skipped' | string> {
  // Only act on sync.successful.* for now
  if (!ev.event_type.startsWith('connection.synced.successful')) {
    return 'skipped';
  }

  // Look up subaccount's OPK
  const { data: sub, error: subErr } = await client
    .from('subaccounts')
    .select('id, opk_public, opk_alg')
    .eq('id', subaccountId)
    .single();
  if (subErr || !sub) return `subaccount lookup failed: ${subErr?.message}`;
  if (!sub.opk_public) {
    // No opt-in. Defer until user opens app (or-sync will drain).
    return 'skipped';
  }
  if (sub.opk_alg !== OPK_SEAL_ALG) {
    return `unsupported opk_alg: ${sub.opk_alg}`;
  }

  // Profile id for Basic auth
  const { data: map, error: mapErr } = await client
    .from('quiltt_profile_map')
    .select('quiltt_profile_id')
    .eq('subaccount_id', subaccountId)
    .single();
  if (mapErr || !map) return `profile map missing: ${mapErr?.message}`;

  const basic = btoa(`${map.quiltt_profile_id}:${apiKey}`);
  let recipientPub: Uint8Array;
  try {
    recipientPub = await decodeOpkPublicKey(sub.opk_public);
  } catch (e) {
    return `invalid opk_public: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Pull transactions paginated. We need the connection id from the
  // event payload to scope the pull.
  const connectionId = typeof ev.payload?.record?.id === 'string' ? ev.payload.record.id : null;
  if (!connectionId) return 'event missing record.id';

  // Find the OR-side connection row tied to this Quiltt link. For Phase
  // 1 we expect or-link-complete (Quiltt branch) to have created it; if
  // not, we skip and let the user-session sync path create it on next
  // open.
  //
  // Schema note: connections.user_id was dropped in
  // 20260421200000_platforms_subaccounts.sql; the current owning column
  // is subaccount_id.
  // Route the event to the OR connection row whose quiltt_connection_id
  // matches the webhook's connectionId. Falls back to a legacy NULL-id
  // row only if no exact match exists — keeps banks linked before the
  // multi-connection migration working. If both fail, surface the
  // mismatch instead of silently writing to the wrong bank's bucket
  // (which was the pre-fix root cause of Mercury+TD collisions).
  let conn: { id: string } | null = null;
  const exactMatch = await client
    .from('connections')
    .select('id')
    .eq('subaccount_id', subaccountId)
    .eq('provider_type', 'quiltt')
    .eq('quiltt_connection_id', connectionId)
    .maybeSingle();
  if (exactMatch.error) return `connection lookup failed: ${exactMatch.error.message}`;
  if (exactMatch.data) {
    conn = exactMatch.data as { id: string };
  } else {
    const legacy = await client
      .from('connections')
      .select('id')
      .eq('subaccount_id', subaccountId)
      .eq('provider_type', 'quiltt')
      .is('quiltt_connection_id', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (legacy.error) return `connection lookup failed: ${legacy.error.message}`;
    if (!legacy.data) return 'or-connection row not yet created';
    conn = legacy.data as { id: string };
  }

  let after: string | null = null;
  let pages = 0;
  let newRows = 0;
  const eventStartMs = Date.now();

  while (pages < MAX_PAGES) {
    // Wall-clock budget guard. If this single event has already burned
    // PER_EVENT_BUDGET_MS, bail and let the next cron tick pick up the
    // remainder. Stops one hostile/slow profile from starving the rest
    // of the batch when the Supabase edge runtime would otherwise be
    // killed at ~150s for the whole invocation.
    if (Date.now() - eventStartMs > PER_EVENT_BUDGET_MS) {
      console.warn(
        `[or-quiltt-sync] event ${connectionId}: per-event budget exhausted after ${pages} pages, ${newRows} rows`,
      );
      break;
    }

    const query = `
      query Q($connId: ID!, $first: Int!, $after: String) {
        connection(id: $connId) { id }
        transactions(filter: { connectionId: $connId }, first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id amount currencyCode date description entryType status
            account { id }
          }
        }
      }
    `;
    const resp = await fetch(QUILTT_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/json',
        'x-region':      QUILTT_REGION_HEADER,
      },
      body: JSON.stringify({
        query,
        variables: { connId: connectionId, first: TX_PAGE_SIZE, after },
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      return `Quiltt GraphQL ${resp.status}: ${errBody.slice(0, 300)}`;
    }
    const json = await resp.json();

    // GraphQL can return HTTP 200 with an `errors` array when a query
    // partially or fully fails (bad connectionId, expired profile,
    // schema mismatch, etc.). Without this check the error is silently
    // dropped: json.data.transactions.nodes evaluates to [] and the
    // inbox event is marked processed with zero rows — data loss with
    // no signal. Surface the errors so bumpAttempts fires and the event
    // stays visible for the next cron tick.
    //
    // Redaction posture: keep only the human-readable `message` from
    // each error, never the whole error object. A GraphQL error also
    // carries `locations`, `path`, and a provider-defined `extensions`
    // blob; serializing all of it into a log and the last_error column
    // is overly broad. Provider messages can additionally embed
    // alphanumeric connection/profile identifiers that a numeric-only
    // filter would never catch. Quiltt IDs are mixed-case (for example
    // conn_14TJiFDKRJlPiBHuukUIlXZ), so a lowercase-only pass would
    // still leak the uppercase characters. We first redact any
    // short-prefix underscore token case-insensitively, then run the
    // numeric redaction on top. The prefix pass is intentionally
    // prefix-agnostic: it does not depend on a hardcoded conn_/prof_
    // list that could drift as Quiltt adds new ID types.
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      const messages = json.errors
        .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
        .filter((m: string) => m.length > 0)
        .join('; ')
        .slice(0, 800);
      const summary = messages
        .replace(/\b[a-z]{2,8}_[A-Za-z0-9]{6,}\b/gi, '[redacted-id]')
        .replace(/\b\d{6,}\b/g, '[redacted]')
        .slice(0, 400);
      console.error(`[or-quiltt-sync] GraphQL errors for event ${ev.event_id}:`, summary);
      return `Quiltt GraphQL errors: ${summary}`;
    }

    const txs = json?.data?.transactions?.nodes ?? [];
    const pageInfo = json?.data?.transactions?.pageInfo;

    for (const tx of txs) {
      const cleartext = JSON.stringify({
        amount:        tx.amount,
        currency:      tx.currencyCode,
        description:   tx.description,
        entry_type:    tx.entryType,
        upstream_status: tx.status,
        account_id:    tx.account?.id,
      });
      const sealedB64 = await sealToOpk(cleartext, recipientPub);

      const insert = await client
        .from('encrypted_transactions')
        .upsert(
          {
            connection_id:       conn.id,
            external_id:         tx.id,
            encrypted_payload:   sealedB64,
            payload_key_version: 1,
            occurred_at:         tx.date,
            sealed_under:        'opk',
            sealed_alg:          OPK_SEAL_ALG,
          },
          { onConflict: 'connection_id,external_id', ignoreDuplicates: true },
        );
      if (insert.error) {
        console.error(`[or-quiltt-sync] tx insert failed (${tx.id}):`, insert.error.message);
      } else {
        newRows++;
      }
    }

    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor ?? null;
    pages++;
  }

  console.log(`[or-quiltt-sync] event ${ev.event_id}: ${newRows} new tx rows across ${pages + 1} pages`);

  // Outbound webhook fan-out. Mirrors or-sync's enqueue pattern: insert a
  // webhook_delivery row when newRows > 0, let or-webhook-dispatch pick it
  // up on its own schedule. Best-effort — failure here must not mark the
  // inbox event as failed; the user data is already landed.
  if (newRows > 0) {
    try {
      const platRow = await client
        .from('platforms')
        .select('webhook_url')
        .eq('id', platformId)
        .maybeSingle();
      const url = platRow.data?.webhook_url;
      if (typeof url === 'string' && url.length > 0) {
        await client.from('webhook_delivery').insert({
          platform_id:   platformId,
          subaccount_id: subaccountId,
          event_type:    'sync.completed',
          payload: {
            event:         'sync.completed',
            provider:      'quiltt',
            subaccount_id: subaccountId,
            connection_id: conn.id,
            synced_count:  newRows,
            ts:            new Date().toISOString(),
          },
        });
      }
    } catch (whErr) {
      console.error(
        `[or-quiltt-sync] webhook enqueue failed for subaccount ${subaccountId}:`,
        whErr instanceof Error ? whErr.message : String(whErr),
      );
    }
  }

  return 'processed';
}

// ─── helpers ─────────────────────────────────────────────────────────

async function markProcessed(client: SupabaseClient, eventId: string) {
  await client
    .from('quiltt_webhook_inbox')
    .update({ processed_at: new Date().toISOString() })
    .eq('event_id', eventId);
}

async function bumpAttempts(client: SupabaseClient, ev: PendingEvent, errMsg: string) {
  const newAttempts = (ev.attempts ?? 0) + 1;
  const terminal    = newAttempts >= MAX_ATTEMPTS;
  const { error } = await client
    .from('quiltt_webhook_inbox')
    .update({
      attempts:   newAttempts,
      last_error: errMsg.slice(0, 500),
      ...(terminal ? { processed_at: new Date().toISOString(), retirement_reason: ('max-attempts:' + errMsg).slice(0, 500) } : {}),
    })
    .eq('event_id', ev.event_id);
  if (error) {
    console.error(
      `[or-quiltt-sync] bumpAttempts UPDATE failed for event ${ev.event_id}: ${error.message}`,
    );
    if (terminal) {
      // The terminal write includes retirement_reason which may not yet exist
      // in prod (schema is applied by #316, which must precede this code in prod).
      // If the column is absent the whole UPDATE is rejected and attempts freezes
      // at its current count. Fall back to a counter-only bump to preserve
      // attempts and last_error so the row is not stuck at a stale count.
      // Note: bumping attempts does NOT advance the row in the batch - ordering
      // is by received_at, not attempts. The real guard against a frozen queue
      // is merge order: #316 applied to prod before this code promotes.
      const { error: fbErr } = await client
        .from('quiltt_webhook_inbox')
        .update({ attempts: newAttempts, last_error: errMsg.slice(0, 500) })
        .eq('event_id', ev.event_id);
      if (fbErr) {
        console.error(
          `[or-quiltt-sync] bumpAttempts fallback also failed for event ${ev.event_id}: ${fbErr.message}`,
        );
      }
    }
  }
  if (terminal) {
    console.warn(
      `[or-quiltt-sync] event ${ev.event_id}: retired to dead-letter after ` +
        `${newAttempts} attempts (${errMsg.slice(0, 100)})`,
    );
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
