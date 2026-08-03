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
 * Vault (or_internal_worker_token, read at invocation via service_role). This endpoint is for OR ops + cron
 * only; never callable from integrators or browsers.
 *
 * Env vars:
 *   QUILTT_API_KEY              — Model A master key
 *   vault: or_internal_worker_token — caller auth token, read from Vault at invocation via service_role
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — standard
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { OPK_SEAL_ALG, decodeOpkPublicKey, sealToOpk } from '../_shared/opk-seal.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  chooseProfileId,
  chooseRouting,
  metadataSubaccountId,
  profileIdFromPayload,
  redactProviderError,
  redactProviderId,
} from './resolve.ts';

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
  // Read expected token via SECURITY DEFINER RPC.
  // Accept-Profile: vault over PostgREST fails at runtime (DL-0599): the vault
  // schema is not exposed via the REST API in the deployed edge runtime. The RPC
  // get_or_internal_worker_token() runs as its owner (postgres), reads
  // vault.decrypted_secrets, and returns the value. service_role can call it;
  // anon and authenticated cannot. Migration: 20260804000000_or_quiltt_sync_vault_rpc.sql
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: expected, error: _vaultErr } = await client.rpc('get_or_internal_worker_token');
  if (_vaultErr) {
    console.error('[or-quiltt-sync] vault RPC failed:', _vaultErr.code, _vaultErr.message);
    return new Response('vault read error', { status: 503 });
  }
  if (!expected) {
    return new Response('worker token missing from vault', { status: 503 });
  }
  if (!callerToken || !timingSafeEqual(callerToken, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  const quilttApiKey = Deno.env.get('QUILTT_API_KEY');
  if (!quilttApiKey) return new Response('QUILTT_API_KEY missing', { status: 503 });

  let processed = 0;
  let failed    = 0;
  let skipped   = 0;

  // Pull a batch of pending, non-deferred events.
  // fetchPendingBatch filters both processed_at IS NULL and opk_deferred_at IS NULL
  // so opk-deferred rows never pile up at the head and starve drainable events.
  const { data: pending, error: pendErr } = await fetchPendingBatch(client, BATCH_SIZE);

  if (pendErr) {
    console.error('[or-quiltt-sync] inbox query failed:', pendErr.message);
    return jsonResponse({ error: 'inbox query failed' }, 500);
  }
  if (!pending || pending.length === 0) {
    return jsonResponse({ processed: 0, failed: 0, skipped: 0, message: 'inbox empty' }, 200);
  }

  for (const ev of pending as PendingEvent[]) {
    try {
      // DL-0596: pre-dispatch cap guard. A row at or above MAX_ATTEMPTS must
      // be retired here, unconditionally, before any routing or dispatch.
      // Without this check, a row that succeeds on a high-attempt tick passes
      // through markProcessed with no retirement_reason, leaving the audit slot
      // NULL.
      //
      // Do NOT call bumpAttempts here. bumpAttempts always writes the error
      // string argument into last_error, which would destroy the real error
      // that drove the row to the cap -- precisely the data someone will need
      // to diagnose these rows. Write processed_at and retirement_reason
      // directly so last_error is preserved untouched.
      if ((ev.attempts ?? 0) >= MAX_ATTEMPTS) {
        const { error: retireErr } = await client
          .from('quiltt_webhook_inbox')
          .update({
            processed_at:      new Date().toISOString(),
            retirement_reason: 'max-attempts-pre-dispatch',
          })
          .eq('event_id', ev.event_id);
        if (retireErr) {
          console.error(
            `[or-quiltt-sync] event ${ev.event_id}: pre-dispatch retirement UPDATE failed (retirement_reason=max-attempts-pre-dispatch): ${retireErr.message}`,
          );
        } else {
          console.warn(
            `[or-quiltt-sync] event ${ev.event_id}: retired pre-dispatch after ` +
              `${ev.attempts ?? 0} attempts (last_error preserved)`,
          );
        }
        failed++;
        continue;
      }

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
      //
      // Those decisions now live in ./resolve.ts, where they are covered by
      // fixtures. What is left here is the two lookups, which are the part
      // that needs a client.
      let { platform_id, subaccount_id } = ev;
      if (!platform_id || !subaccount_id) {
        const profileId = profileIdFromPayload(ev);
        const metaSub   = metadataSubaccountId(ev);

        const mapRow = profileId
          ? (await client
            .from('quiltt_profile_map')
            .select('platform_id, subaccount_id')
            .eq('quiltt_profile_id', profileId)
            .maybeSingle()).data
          : null;

        const subRow = metaSub
          ? (await client
            .from('subaccounts')
            .select('id, platform_id')
            .eq('id', metaSub)
            .maybeSingle()).data
          : null;

        const routed = chooseRouting(ev, mapRow, subRow);
        if (routed.source === 'metadata') {
          console.warn(
            `[or-quiltt-sync] event ${ev.event_id}: routed via profile metadata ` +
              `after quiltt_profile_map missed (profile ${profileId ?? 'unknown'})`,
          );
        }
        platform_id   = routed.platform_id;
        subaccount_id = routed.subaccount_id;

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
      } else if (handled === 'deferred') {
        // opk_public not yet set. Stamp opk_deferred_at so the batch query
        // skips this row on future ticks. When the subaccount registers an
        // OPK, the caller must clear opk_deferred_at for this row to
        // re-enter the queue.
        await markDeferred(client, ev.event_id);
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

export async function handleEvent(
  client: SupabaseClient,
  ev: PendingEvent,
  platformId: string,
  subaccountId: string,
  apiKey: string,
): Promise<'processed' | 'skipped' | string> {
  // Reconcile connection status on Quiltt error events without pulling data (DL-0441).
  // These events mean Quiltt's own bank connection is broken; the OR connections table
  // must reflect that so callers (e.g. the app's connection health UI) see the truth.
  // Match on the shared prefix rather than an enumeration of subtypes: Quiltt's full
  // errored taxonomy is not guaranteed to be bounded, and a subtype not listed here
  // would fall through to 'skipped' without reconciling, which is the gap this fix closes.
  if (ev.event_type.startsWith('connection.synced.errored')) {
    const reconcileErr = await reconcileConnectionError(client, ev, subaccountId);
    if (reconcileErr) return reconcileErr;
    return 'processed';
  }

  // Only act on sync.successful.* for data pulls
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
  // Extract connectionId and reconcile success status BEFORE the OPK gate so that
  // every subaccount (not just OPK-opted-in ones) can recover from error state.
  // Placing this after the OPK gate made error a terminal state for non-opted-in subaccounts.
  const connectionId = typeof ev.payload?.record?.id === 'string' ? ev.payload.record.id : null;
  if (!connectionId) return 'event missing record.id';

  // Quiltt confirms successful sync: clear any error state so the connection shows active.
  // Called before the OPK gate so the status fix covers ALL subaccounts.
  const successErr = await reconcileConnectionSuccess(client, connectionId, subaccountId);
  if (successErr) return successErr;

  if (!sub.opk_public) {
    // No opt-in. Status already reconciled above. Defer data pull until user opens app.
    return 'deferred';
  }
  if (sub.opk_alg !== OPK_SEAL_ALG) {
    return `unsupported opk_alg: ${sub.opk_alg}`;
  }

  // Profile id for Basic auth.
  //
  // maybeSingle, not single: a missing map row is an expected state, not a
  // query failure. Every Quiltt profile minted before the map's first row on
  // 2026-06-10 has none, and none can be created for them, because
  // quiltt_environment_id is NOT NULL and no webhook payload carries an
  // environment id. Treating that as an error is what returned `profile map
  // missing` on every tick forever (DL-0465).
  //
  // The fallback is the profile id on the payload, which arrived on an
  // HMAC-verified request. It scopes the data pull and nothing else: the
  // platform this data is filed under still comes off the subaccount row.
  //
  // Note this reads the map by subaccount_id, while the re-resolve block above
  // reads it by profile id. Two keys into one table can disagree, and here they
  // do: a legacy subaccount that later mints a session gets a NEW profile mapped
  // to it while its queued events still carry the old one. chooseProfileId keeps
  // the event's own profile in that case, because only that credential can read
  // the connection the event is about.
  const { data: map, error: mapErr } = await client
    .from('quiltt_profile_map')
    .select('quiltt_profile_id')
    .eq('subaccount_id', subaccountId)
    .maybeSingle();
  if (mapErr) return `profile map lookup failed: ${mapErr.message}`;

  const profile = chooseProfileId(map?.quiltt_profile_id ?? null, ev, subaccountId);
  if (profile.source === 'route-conflict') {
    // The payload would have supplied the credential, and it does not agree
    // with us about where its own data belongs. That is the signature of a row
    // misrouted by the receiver's old malformed-batch index shift: the stored
    // route is complete and confidently wrong. Authenticating as the payload
    // here succeeds, and lands one customer's transactions under another
    // customer's OPK. Refusing costs this event a retry, which is recoverable.
    // The alternative is not.
    console.error(
      `[or-quiltt-sync] event ${ev.event_id}: routed to subaccount ${subaccountId}, but the ` +
        `payload's profile metadata does not name that subaccount. Refusing to authenticate ` +
        `with the payload's profile. Suspect a misrouted inbox row (DL-0465)`,
    );
    return 'payload profile does not corroborate the routed subaccount';
  }
  if (!profile.profileId) return 'no quiltt profile id (no map row, none in payload)';
  if (profile.source === 'payload') {
    console.warn(
      `[or-quiltt-sync] event ${ev.event_id}: no quiltt_profile_map row for this ` +
        `subaccount, using the profile id from the verified payload (DL-0465)`,
    );
  } else if (profile.source === 'payload-rebound') {
    // Ids redacted on the same posture as the GraphQL error path below: a
    // Quiltt identifier does not belong in an edge function log. That does cost
    // this line the ability to show that the two ids differ, which is the whole
    // point of it, so the sentence says so and points at where both live. A
    // human holding the event id can read them from the inbox row and the map.
    console.warn(
      `[or-quiltt-sync] event ${ev.event_id}: subaccount ${subaccountId} is mapped to ` +
        `${redactProviderId(String(map?.quiltt_profile_id ?? ''))}, but this event came from a ` +
        `different profile, ${redactProviderId(profile.profileId)}. Using the event's own ` +
        `profile. The subaccount was rebound by a later session mint and now has two Quiltt ` +
        `profiles; both ids are on the inbox row and in quiltt_profile_map (DL-0465)`,
    );
  }

  const basic = btoa(`${profile.profileId}:${apiKey}`);
  let recipientPub: Uint8Array;
  try {
    recipientPub = await decodeOpkPublicKey(sub.opk_public);
  } catch (e) {
    return `invalid opk_public: ${e instanceof Error ? e.message : String(e)}`;
  }

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
      return `Quiltt GraphQL ${resp.status}: ${redactProviderError(errBody, 300)}`;
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
    // Keep only the human-readable `message` from each error, never the
    // whole error object. A GraphQL error also carries `locations`,
    // `path`, and a provider-defined `extensions` blob; serializing all
    // of it into a log and the last_error column is overly broad.
    //
    // Redacting whatever survives that is redactProviderError's job, not
    // this branch's. It is applied to every return from this call, so
    // read the posture there rather than here: a comment sitting on one
    // conditional describes that conditional and nothing else.
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      const messages = json.errors
        .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
        .filter((m: string) => m.length > 0)
        .join('; ');
      const summary = redactProviderError(messages, 400);
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

// ─── Quiltt error reconciliation ────────────────────────────────────

/**
 * Handle connection.synced.errored.repairable and .provider events.
 * Finds the OR-side connection row and flips status to 'error' so the
 * connections table reflects Quiltt's own view of the connection health.
 * No transaction data is pulled. No DDL required (DL-0441).
 */
async function reconcileConnectionError(
  client: SupabaseClient,
  ev: PendingEvent,
  subaccountId: string,
): Promise<string | null> {
  const connectionId = typeof ev.payload?.record?.id === 'string'
    ? ev.payload.record.id
    : null;
  if (!connectionId) return 'event missing record.id';

  // Prefer an exact quiltt_connection_id match; fall back to the legacy
  // NULL-id row only if no exact match exists -- same pattern as handleEvent.
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
    if (!legacy.data) {
      // No OR-side connection row yet; nothing to reconcile.
      // Mark processed so the event does not retry forever.
      console.warn(
        `[or-quiltt-sync] event ${ev.event_id}: error event for Quiltt connection ` +
          `(type: ${ev.event_type}), no OR connection row found -- marking processed`,
      );
      return null;
    }
    conn = legacy.data as { id: string };
  }

  const { error } = await client
    .from('connections')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('id', conn.id);
  if (error) return `connection status update failed: ${error.message}`;

  console.log(
    `[or-quiltt-sync] event ${ev.event_id}: connection ${conn.id} ` +
      `reconciled to error (event_type: ${ev.event_type})`,
  );
  return null;
}

/**
 * When Quiltt reports a successful connection sync, flip any error row back to active.
 * Uses the same lookup pattern as reconcileConnectionError: exact quiltt_connection_id
 * match first, legacy NULL-id fallback for pre-migration rows.
 * Only transitions error -> active; leaves pending/active rows untouched.
 */
async function reconcileConnectionSuccess(
  client: SupabaseClient,
  connectionId: string,
  subaccountId: string,
): Promise<string | null> {
  let orConnId: string | null = null;
  const { data: exact, error: exactErr } = await client
    .from('connections')
    .select('id')
    .eq('subaccount_id', subaccountId)
    .eq('provider_type', 'quiltt')
    .eq('quiltt_connection_id', connectionId)
    .maybeSingle();
  if (exactErr) return `connection lookup failed: ${exactErr.message}`;
  if (exact) {
    orConnId = exact.id;
  } else {
    const { data: legacy, error: legacyErr } = await client
      .from('connections')
      .select('id')
      .eq('subaccount_id', subaccountId)
      .eq('provider_type', 'quiltt')
      .is('quiltt_connection_id', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (legacyErr) return `connection lookup failed: ${legacyErr.message}`;
    if (legacy) orConnId = legacy.id;
  }
  if (!orConnId) return null;
  const { error: statusErr } = await client
    .from('connections')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', orConnId)
    .eq('status', 'error');
  if (statusErr) return `connection status update failed: ${statusErr.message}`;
  console.log(
    `[or-quiltt-sync] connection ${orConnId} reconciled to active`,
  );
  return null;
}

// ─── helpers ─────────────────────────────────────────────────────────

async function markProcessed(client: SupabaseClient, eventId: string) {
  await client
    .from('quiltt_webhook_inbox')
    .update({ processed_at: new Date().toISOString() })
    .eq('event_id', eventId);
}

async function bumpAttempts(client: SupabaseClient, ev: PendingEvent, rawErrMsg: string) {
  // Redact once, on entry, before anything below applies a length limit (#333).
  //
  // This is the only function in this file that writes last_error or
  // retirement_reason, so redacting here covers all four sinks below - the two
  // column writes, the fallback write, and the console.warn - and covers every
  // caller that exists today plus any added later, by construction.
  //
  // Doing it per-sink instead would need four separate edits and would
  // reintroduce the #330 ordering defect at the console.warn, which applies its
  // own shorter limit to its own copy of the string. Doing it per-caller would
  // need three, and the middle one (the handleEvent result) is a funnel for
  // eight different failure returns, so "the caller redacts" would still leave
  // the question open at every one of them.
  //
  // The limit is the widest sink (500), so nothing is dropped here that a sink
  // would otherwise have kept. Every slice below therefore cuts already-redacted
  // text, which is the property #330 established as the safe order.
  //
  // redactProviderError is idempotent, so the two returns that already redact
  // (the non-ok and GraphQL-errors branches of the transactions fetch) pass
  // through this unchanged rather than being mangled a second time.
  const errMsg = redactProviderError(rawErrMsg, 500);
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
      // retirement_reason column is confirmed present in prod (SQLA-00069
      // applied; verified by Auditor 2026-08-03). This fallback fires only if
      // the combined UPDATE fails for any reason other than column absence
      // (transient DB error, constraint violation, etc.). It preserves attempts
      // and last_error so the row is not stuck at a stale count. Batch ordering
      // is by received_at, not attempts, so this fallback does not shift queue
      // head position in either direction.
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

export async function fetchPendingBatch(client: SupabaseClient, batchSize: number) {
  return client
    .from('quiltt_webhook_inbox')
    .select('event_id, event_type, payload, platform_id, subaccount_id, attempts')
    .is('processed_at', null)
    .is('opk_deferred_at', null)
    .order('received_at', { ascending: true })
    .limit(batchSize);
}

export async function markDeferred(client: SupabaseClient, eventId: string) {
  await client
    .from('quiltt_webhook_inbox')
    .update({ opk_deferred_at: new Date().toISOString() })
    .eq('event_id', eventId);
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
