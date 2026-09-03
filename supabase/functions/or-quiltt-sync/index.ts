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
import { buildSyncCompletedPayload } from '../_shared/webhook-events.ts';
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
const REDRIVE_SWEEP_SIZE = 500;  // max rows fetched in step 1 of reDriveReadyDeferrals per tick
// How long a 'deferred-conn-race' row (DL-1414-C) can sit waiting on its
// connections row before we log a loud warning about it. This case is never
// retired via MAX_ATTEMPTS (OR-T1902): deferral is the correct behavior for
// as long as the race is unresolved, so the bound on its cost is visibility,
// not deletion.
const CONN_RACE_STALE_WARNING_MS = 24 * 60 * 60 * 1000;  // 24h

// Platforms that use sink delivery instead of OPK encryption (DL-0853).
// Positive allowlist per DEC-0092 scope: extending to a new platform requires
// a new founder ruling naming that slug. bitbooks-v3 is NOT in this list:
// it has NULL sink_format, no Quiltt API key, and zero events on prod.
const SINK_DELIVERY_PLATFORMS = new Set<string>(['bitbooks-v2', 'bbv2stg']);

// Per-event wall-clock budget. A pathological profile (many bound
// connections, slow Quiltt responses, or hostile fanout) can otherwise
// exhaust the Supabase edge-runtime ~150s wall and starve the rest of
// the batch. Cap each event at 60s; if we run over, mark the connection
// `partial` and consume the event. The cursor is not persisted; the
// next Quiltt webhook for this connection drives a fresh full pull.
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
  received_at?:  string;
}

const _drainHandler = wrapSentryHandler(async (req: Request) => {
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

  // DL-0643: Re-admit OPK-deferred rows whose subaccounts have since
  // registered a public key. Runs each tick so subaccounts that registered
  // before or-sync-key-register's clearDeferredRows shipped are unblocked
  // without waiting for a new registration event.
  const { reDriven, error: reDriveErr } = await reDriveReadyDeferrals(client);
  if (reDriveErr) {
    console.error('[or-quiltt-sync] reDriveReadyDeferrals failed:', reDriveErr);
  }
  if (reDriven > 0) {
    console.log(`[or-quiltt-sync] re-admitted ${reDriven} OPK-deferred rows`);
  }

  // Pull a batch of pending, non-deferred events.
  // fetchPendingBatch filters both processed_at IS NULL and opk_deferred_at IS NULL
  // so opk-deferred rows never pile up at the head and starve drainable events.
  const { data: pending, error: pendErr } = await fetchPendingBatch(client, BATCH_SIZE);

  if (pendErr) {
    console.error('[or-quiltt-sync] inbox query failed:', pendErr.message);
    return jsonResponse({ error: 'inbox query failed', reDriven, ...(reDriveErr ? { reDriveError: reDriveErr } : {}) }, 500);
  }
  if (!pending || pending.length === 0) {
    return jsonResponse({ processed: 0, failed: 0, skipped: 0, message: 'inbox empty', reDriven, ...(reDriveErr ? { reDriveError: reDriveErr } : {}) }, 200);
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
      } else if (handled === 'deferred-conn-race') {
        // connections row missing (race with or-link-complete, DL-1414-C).
        // Defer so the event sits out one tick. Do NOT bump attempts here:
        // this is an expected-to-eventually-resolve wait, not a failure, and
        // bumping attempts toward MAX_ATTEMPTS silently and permanently
        // discards the event once the count is exhausted (OR-T1902). This
        // restores pull request 801's fix: a later commit (5418820c) added
        // bumpAttempts back to bound the tick cost below, which undid it and started
        // burning real customer events again within hours of cron running.
        //
        // The tick-cost concern that motivated bumpAttempts is real (this row
        // re-enters the batch every tick once opk_public is set, since
        // reDriveReadyDeferrals cannot tell "waiting on OPK" apart from
        // "waiting on the connections row"), so bound it with a loud,
        // non-destructive signal instead of a destructive one.
        await markDeferred(client, ev.event_id);
        if (ev.received_at) {
          const ageMs = Date.now() - new Date(ev.received_at).getTime();
          if (ageMs > CONN_RACE_STALE_WARNING_MS) {
            console.warn(
              `[or-quiltt-sync] event ${ev.event_id}: still waiting on connections row ` +
                `(DL-1414-C) after ${Math.floor(ageMs / 3_600_000)}h, subaccount ${subaccount_id}`,
            );
          }
        }
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

  return jsonResponse({ processed, failed, skipped, reDriven, ...(reDriveErr ? { reDriveError: reDriveErr } : {}), batch: pending.length }, 200);
}, 'or-quiltt-sync');
if (import.meta.main) Deno.serve(_drainHandler);

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

  // Clear error state before the OPK gate so all subaccounts can recover from error.
  // Partial is intentionally NOT cleared here: if the data pull fails below, the
  // connection must stay partial. The partial -> active transition happens post-pull.
  const successErr = await reconcileConnectionSuccess(client, connectionId, subaccountId);
  if (successErr) return successErr;

  // DL-0853: determine delivery model from the platform row.
  // Sink-mode platforms bypass the OPK gate and use handleEventSinkDelivery,
  // which upserts the connections row and enqueues a webhook so the integrator
  // calls or-sync for data on demand. The allowlist is explicit per DEC-0092 scope.
  const { data: platDelivery } = await client
    .from('platforms')
    .select('slug')
    .eq('id', platformId)
    .maybeSingle();
  const isSinkPlatform = SINK_DELIVERY_PLATFORMS.has(platDelivery?.slug ?? '');

  if (!sub.opk_public) {
    if (isSinkPlatform) {
      // Sink-mode platform: no OPK required. Ensure the connections row exists
      // and fire the webhook so the integrator calls or-sync for data on demand.
      return await handleEventSinkDelivery(client, ev, connectionId, platformId, subaccountId);
    }
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
    // DL-1414-C: Quiltt webhook arrived before or-link-complete created the
    // connections row (timing race on first connect or reconnect). Return
    // 'deferred-conn-race' so the drain loop defers the row (markDeferred)
    // WITHOUT bumping its attempt counter (OR-T1902). opk_public is already
    // set here (we passed the gate above), so reDriveReadyDeferrals re-admits
    // the event on the very next tick regardless of why it was deferred, and
    // this row re-enters the batch on every tick until the connections row
    // appears. That tick cost is real but is not a reason to permanently
    // discard the event: bumping attempts toward MAX_ATTEMPTS on this path
    // (commit 5418820c) undid PR #801's fix and started silently retiring
    // events whose connections row would have appeared eventually. The
    // caller logs a loud warning once the wait is abnormally long instead,
    // so this stays visible without being destructive.
    if (!legacy.data) return 'deferred-conn-race';
    conn = legacy.data as { id: string };
  }

  // DL-0442: load account selection for this connection once, before paging.
  // A connection with no source_wallets rows keeps the all-sync fallback (pre-feature behaviour).
  // A connection with rows syncs only accounts where is_synced=true.
  const { data: swRows, error: swErr } = await client
    .from('source_wallets')
    .select('external_wallet_id, is_synced')
    .eq('connection_id', conn.id);
  if (swErr) {
    console.error(
      `[or-quiltt-sync] source_wallets lookup failed for connection ${conn.id}:`,
      swErr.message,
    );
    // Fail closed: we cannot determine which accounts are selected, so do
    // not fall through to all-sync. The event will retry on the next tick.
    return `source_wallets lookup failed: ${swErr.message}`;
  }
  // selectedAccountIds === null means no rows present: sync everything (all-sync fallback).
  // When rows exist, only accounts with is_synced=true are included.
  // Retention policy (DL-0740 / issue #647): accounts with is_synced=false are skipped for
  // future data pulls but their existing encrypted_transactions rows are NOT deleted. Data
  // is preserved so the user can re-enable an account without losing history.
  const selectedAccountIds: Set<string> | null =
    swRows && swRows.length > 0
      ? new Set(
          swRows
            .filter((r: { is_synced: boolean }) => r.is_synced)
            .map((r: { external_wallet_id: string }) => r.external_wallet_id),
        )
      : null;

  // DL-0741: Quiltt's TransactionFilter accepts accountIds ([ID!]) but not
  // connectionId. When source_wallets has an account selection (DL-0442), use
  // those ids directly. Otherwise pre-fetch all account ids for the connection
  // once before the paging loop so subsequent pages can use the correct filter.
  let filterAccountIds: string[];
  if (selectedAccountIds !== null) {
    filterAccountIds = [...selectedAccountIds];
    if (filterAccountIds.length === 0) {
      // All accounts deselected by the user. No data to pull. Mark the event processed
      // so it does not retry: the selection is the user's intent and will not change
      // until they update source_wallets. reconcileConnectionSuccess already ran above.
      // Existing encrypted_transactions rows are retained (retention policy, DL-0740).
      console.log(
        `[or-quiltt-sync] event ${ev.event_id}: all accounts deselected, skipping data pull`,
      );
      return 'processed';
    }
  } else {
    const acctResp = await fetch(QUILTT_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/json',
        'x-region':      QUILTT_REGION_HEADER,
      },
      body: JSON.stringify({
        query: `query GetAccounts($connId: ID!) {
          connection(id: $connId) {
            accounts { id }
          }
        }`,
        variables: { connId: connectionId },
      }),
    });
    if (!acctResp.ok) {
      const errBody = await acctResp.text().catch(() => '');
      return `Quiltt accounts fetch ${acctResp.status}: ${redactProviderError(errBody, 300)}`;
    }
    const acctJson = await acctResp.json();
    if (Array.isArray(acctJson?.errors) && acctJson.errors.length > 0) {
      const msgs = acctJson.errors
        .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
        .filter((m: string) => m.length > 0)
        .join('; ');
      return `Quiltt accounts fetch errors: ${redactProviderError(msgs, 400)}`;
    }
    filterAccountIds = (
      (acctJson?.data?.connection?.accounts ?? []) as Array<{ id: string }>
    ).map((a) => a.id);
    if (filterAccountIds.length === 0) {
      // Connection has no accounts yet -- possibly still provisioning.
      // Return an error so the event stays in the inbox and retries next tick.
      console.warn(
        `[or-quiltt-sync] event ${ev.event_id}: connection ${connectionId} has no accounts, will retry`,
      );
      return 'connection has no accounts at Quiltt';
    }
  }

  let after: string | null = null;
  let pages = 0;
  let newRows = 0;
  let budgetExhausted = false;
  const eventStartMs = Date.now();

  while (pages < MAX_PAGES) {
    // Wall-clock budget guard. If this single event has already burned
    // PER_EVENT_BUDGET_MS, bail and let the next cron tick pick up the
    // remainder. Stops one hostile/slow profile from starving the rest
    // of the batch when the Supabase edge runtime would otherwise be
    // killed at ~150s for the whole invocation.
    if (Date.now() - eventStartMs > PER_EVENT_BUDGET_MS) {
      console.warn(
        `[or-quiltt-sync] event ${ev.event_id}: per-event budget exhausted after ${pages} pages, ${newRows} rows`,
      );
      budgetExhausted = true;
      break;
    }

    const query = `
      query Q($accountIds: [ID!]!, $first: Int!, $after: String) {
        transactions(filter: { accountIds: $accountIds }, first: $first, after: $after) {
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
        variables: { accountIds: filterAccountIds, first: TX_PAGE_SIZE, after },
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
      // DL-0442: skip transactions for accounts the user has not selected.
      // selectedAccountIds === null means no source_wallets rows: sync all accounts.
      // When selection is active, a null account.id is unidentifiable and therefore
      // unselectable: skip it rather than letting it bypass the filter silently.
      if (selectedAccountIds !== null) {
        if (
          tx.account?.id == null ||
          !selectedAccountIds.has(tx.account.id as string)
        ) {
          continue;
        }
      }

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
    if (pages >= MAX_PAGES) {
      // Page cap reached with more data remaining. Same outcome as the
      // wall-clock exit: mark partial so callers see the incomplete state.
      // The cursor is not persisted; the next Quiltt webhook drives a fresh
      // full pull.
      budgetExhausted = true;
    }
  }

  if (budgetExhausted) {
    const { error: partialErr } = await client
      .from('connections')
      .update({ status: 'partial', updated_at: new Date().toISOString() })
      .eq('id', conn.id);
    if (partialErr) {
      console.error(
        `[or-quiltt-sync] event ${ev.event_id}: failed to set partial status:`,
        partialErr.message,
      );
    } else {
      console.log(
        `[or-quiltt-sync] event ${ev.event_id}: connection ${conn.id} set to partial ` +
          `(budget exhausted after ${pages} pages, ${newRows} rows)`,
      );
    }
  }

  if (!budgetExhausted) {
    // Pull completed in full; clear any previous partial flag now that data is complete.
    const { error: clearPartialErr } = await client
      .from('connections')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', conn.id)
      .eq('status', 'partial');
    if (clearPartialErr) {
      console.error(
        `[or-quiltt-sync] event ${ev.event_id}: failed to clear partial status:`,
        clearPartialErr.message,
      );
    } else {
      console.log(
        `[or-quiltt-sync] event ${ev.event_id}: connection ${conn.id} cleared from partial to active (full pull)`,
      );
    }
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
          payload: buildSyncCompletedPayload({
            subaccountId,
            connectionId: conn.id,
            syncedCount:  newRows,
            provider:     'quiltt',
          }),
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

/**
 * Deliver a Quiltt sync event for a sink-mode platform (DL-0853).
 *
 * Sink-mode platforms (bitbooks-v2, bbv2stg) do not use OPK encryption.
 * They pull data on demand via or-sync, which has a direct Quiltt profile
 * fallback when the inbox is empty. This function:
 *   1. Upserts the connections row idempotently so or-sync can find it.
 *      or-quiltt-link-complete normally creates this row from the browser,
 *      but that callback is optional and may not have fired yet (DL-0853
 *      root cause: REQUIRED server record behind an OPTIONAL browser callback).
 *   2. Enqueues a sync.completed webhook so the integrator knows to call
 *      or-sync for the data.
 *
 * Returns 'processed' so the inbox event is consumed and not retried.
 */
export async function handleEventSinkDelivery(
  client: SupabaseClient,
  ev: PendingEvent,
  quilttConnectionId: string,
  platformId: string,
  subaccountId: string,
): Promise<'processed' | string> {
  // Step 1: idempotent insert of the connections row.
  // The unique index on (subaccount_id, quiltt_connection_id) is PARTIAL
  // (WHERE provider_type = 'quiltt' AND quiltt_connection_id IS NOT NULL).
  // PostgREST's onConflict string cannot express a partial-index predicate, so
  // upsert with onConflict throws every time. Use plain insert and treat 23505
  // (unique_violation) as success -- row already exists from or-quiltt-link-complete.
  const { error: insertErr } = await client
    .from('connections')
    .insert({
      subaccount_id:           subaccountId,
      provider_type:           'quiltt',
      quiltt_connection_id:    quilttConnectionId,
      encrypted_credentials:   'quiltt-managed',
      credentials_key_version: 1,
      // DL-1409: was 'pending'. Nothing in this worker could ever clear it.
      // 'pending' belongs to the atomic connect flow, where a consumer calls
      // or-connection-confirm (pending -> active) or or-connection-cancel
      // (row deleted). A sink row has no consumer handshake and no wallet
      // write to protect, so it never got either call and sat pending forever.
      // or-quiltt-link-complete already inserts 'active' directly on its own
      // no-accounts branch, so this matches the existing contract rather than
      // inventing one. This insert is insert-only (23505 is treated as
      // success below), so it can never overwrite the status of a row that
      // or-quiltt-link-complete created.
      status:                  'active',
    });
  // 23505 = unique_violation: connection row already exists, which is fine.
  if (insertErr && insertErr.code !== '23505') {
    return `sink connection insert failed: ${insertErr.message}`;
  }

  // Step 2: resolve the connection row id (pre-existing or just created).
  const { data: connRow, error: connLookupErr } = await client
    .from('connections')
    .select('id')
    .eq('subaccount_id', subaccountId)
    .eq('provider_type', 'quiltt')
    .eq('quiltt_connection_id', quilttConnectionId)
    .maybeSingle();
  if (connLookupErr || !connRow) {
    return `sink connection lookup failed after upsert: ${connLookupErr?.message ?? 'not found'}`;
  }

  // Step 3: best-effort webhook enqueue. Failure must not block inbox event consumption.
  try {
    const { data: platRow } = await client
      .from('platforms')
      .select('webhook_url')
      .eq('id', platformId)
      .maybeSingle();
    const url = platRow?.webhook_url;
    if (typeof url === 'string' && url.length > 0) {
      await client.from('webhook_delivery').insert({
        platform_id:   platformId,
        subaccount_id: subaccountId,
        event_type:    'sync.completed',
        // Zero is the honest value here, not a placeholder. Sink delivery
        // means we pulled no rows ourselves: the whole point of the webhook
        // is to tell the consumer to come and call or-sync. The OPK path
        // reports a real row count because it did pull rows.
        payload: buildSyncCompletedPayload({
          subaccountId,
          connectionId: connRow.id,
          syncedCount:  0,
          provider:     'quiltt',
        }),
      });
    }
  } catch (whErr) {
    console.error(
      `[or-quiltt-sync] event ${ev.event_id}: sink webhook enqueue failed for ` +
        `platform ${platformId}: ${whErr instanceof Error ? whErr.message : String(whErr)}`,
    );
  }

  console.log(
    `[or-quiltt-sync] event ${ev.event_id}: sink-mode delivery queued ` +
      `(platform=${platformId}, connection=${connRow.id})`,
  );
  return 'processed';
}

// ─── Quiltt error reconciliation ────────────────────────────────────

/**
 * Handle connection.synced.errored.repairable and .provider events.
 * Finds the OR-side connection row and flips status to 'error' so the
 * connections table reflects Quiltt's own view of the connection health.
 * No transaction data is pulled. No DDL required (DL-0441).
 */
export async function reconcileConnectionError(
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

  // DL-1445: record WHY, not just THAT. This block used to write status alone,
  // so a Quiltt connection could sit in 'error' with encrypted_last_error NULL
  // and no operator or support path could ever say what went wrong. Two
  // production connections were in exactly that state. The cause was in scope
  // the whole time: it is the event subtype, which the log line below already
  // printed and then threw away.
  //
  // Sink-mode only, deliberately. Per the V2 contract the column is PLAINTEXT
  // on sink platforms, which is why this can be written here at all. This
  // worker holds no transaction key and cannot encrypt, so on a non-sink
  // platform we leave the column alone rather than write a value a legacy
  // client would try to decrypt and fail on. Every Quiltt connection on
  // production today is on a sink platform, so this gate is a no-op now and
  // correct if that ever changes.
  const { data: platRow, error: platErr } = await client
    .from('platforms')
    .select('sink_format')
    .eq('id', ev.platform_id)
    .maybeSingle();
  // Review follow-up on PR 808. A failed read leaves platRow undefined, which
  // makes sinkMode false, which silently reproduces the exact NULL-cause state
  // this function was changed to prevent. The cause_recorded flag below makes
  // that observable, but the read error itself was being discarded, so nobody
  // could tell a transient platforms failure apart from a genuine non-sink
  // platform. Log them differently. Deliberately NOT returning an error: a
  // platforms read failure must not stop the status reconcile, which is the
  // more important half and does not depend on this lookup.
  if (platErr) {
    console.error(
      `[or-quiltt-sync] event ${ev.event_id}: platforms lookup failed for ` +
        `platform ${ev.platform_id}, treating as non-sink so no cause will be ` +
        `recorded: ${platErr.message}`,
    );
  }
  const sinkMode = typeof platRow?.sink_format === 'string' && platRow.sink_format.length > 0;

  const connPatch: Record<string, unknown> = {
    status:     'error',
    updated_at: new Date().toISOString(),
  };
  const code = upstreamCodeForErroredEvent(ev.event_type);
  const correlationId = randomCorrelationId();
  if (sinkMode) {
    // Same shape or-sync writes: CODE:correlationId. Never the raw upstream text.
    connPatch.encrypted_last_error = `${code}:${correlationId}`;
  }

  const { error } = await client
    .from('connections')
    .update(connPatch)
    .eq('id', conn.id);
  if (error) return `connection status update failed: ${error.message}`;

  console.log(
    `[or-quiltt-sync] event ${ev.event_id}: connection ${conn.id} ` +
      `reconciled to error (event_type: ${ev.event_type}, code: ${code}, ` +
      `correlation_id: ${correlationId}, cause_recorded: ${sinkMode})`,
  );
  return null;
}

/**
 * Map a Quiltt errored event subtype onto the shared error catalog.
 *
 * Derived from event_type and NOT from payload.record.status: on production
 * 2 of 209 repairable events arrived with a truncated payload and no status
 * field at all, while the subtype is always present. Measured, not assumed.
 *
 * ERROR_REPAIRABLE is documented in our own Knowledge base, verified against
 * Quiltt's reconnect docs: it "can only be repaired by the user re
 * authenticating with the institution". That is precisely what
 * UPSTREAM_AUTH_FAILED tells the customer, including its "Reconnect this
 * account" action.
 *
 * ERROR_PROVIDER is mapped to UPSTREAM_UNAVAILABLE, which tells the customer
 * the service behind the account is unreachable and to try again shortly.
 * That reading comes from the subtype name and from it being the residual
 * class after repairable; I did not find it spelled out in a doc the way
 * ERROR_REPAIRABLE is.
 *
 * Anything else under the errored prefix falls to UPSTREAM_OTHER. Quiltt's
 * errored taxonomy is explicitly not guaranteed to be bounded (see handleEvent),
 * so an unknown subtype must still record a cause rather than record nothing.
 */
export function upstreamCodeForErroredEvent(eventType: string): string {
  if (eventType === 'connection.synced.errored.repairable') return 'UPSTREAM_AUTH_FAILED';
  if (eventType === 'connection.synced.errored.provider')   return 'UPSTREAM_UNAVAILABLE';
  return 'UPSTREAM_OTHER';
}

/**
 * Opaque short id so a customer-visible failure can be cross-referenced against
 * the edge logs. Same construction as or-sync's, and not security sensitive.
 */
function randomCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * When Quiltt reports a successful connection sync, flip any error row back to active.
 * Uses the same lookup pattern as reconcileConnectionError: exact quiltt_connection_id
 * match first, legacy NULL-id fallback for pre-migration rows.
 * Transitions error -> active always, and pending -> active ONLY on the exact
 * quiltt_connection_id match path. Leaves partial and active rows untouched.
 * Callers that confirmed a full data pull should also clear partial -> active post-pull.
 */
export async function reconcileConnectionSuccess(
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
  // Whether we resolved the row Quiltt is actually talking about, or fell back
  // to "the oldest legacy row for this subaccount". The distinction decides
  // which statuses may be promoted below.
  let matchedExactly = false;
  if (exact) {
    orConnId = exact.id;
    matchedExactly = true;
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
    // DL-1409: 'pending' is promotable here so rows stranded by the old sink
    // insert heal themselves on the next successful Quiltt sync, instead of
    // needing a manual UPDATE on production. Quiltt reporting a successful
    // sync is positive evidence the connection works, which is exactly what
    // 'active' asserts.
    //
    // But ONLY on the exact quiltt_connection_id match. The legacy fallback
    // above resolves "the oldest quiltt row for this subaccount with a NULL
    // id", which is not necessarily the connection this event is about.
    // Promoting a pending row on that path could activate a different
    // connection than the one that succeeded, and the promotion is not
    // reversible by the consumer: cancelPendingConnection in
    // _shared/connection-state.ts returns 'already_active' and refuses to
    // delete once the row is active. So the legacy path stays 'error' only,
    // which is exactly the behaviour it had before this change.
    .in('status', matchedExactly ? ['error', 'pending'] : ['error']);
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
    .select('event_id, event_type, payload, platform_id, subaccount_id, attempts, received_at')
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

/**
 * Re-admit OPK-deferred rows whose subaccount now has opk_public set.
 *
 * Rows sit in deferred state (opk_deferred_at IS NOT NULL) when a
 * connection.synced.successful event arrived before the subaccount
 * registered its OPK. Normally or-sync-key-register clears them at
 * key-registration time. Subaccounts that registered their key before
 * that code shipped, or that registered while holding no pending deferred
 * rows, are never unblocked by that path. This sweep finds them each
 * drain tick and nulls opk_deferred_at so fetchPendingBatch can pick
 * them up (DL-0643).
 *
 * Returns { reDriven, error } where reDriven is the number of rows
 * re-admitted and error is a non-fatal message string (null on success).
 * Exported for unit testing.
 */
export async function reDriveReadyDeferrals(
  client: SupabaseClient,
): Promise<{ reDriven: number; error: string | null }> {
  // Step 1: collect distinct subaccount IDs with live deferred rows.
  // Ordered by opk_deferred_at ASC so the oldest-deferred subaccounts are swept
  // first. Bounded by REDRIVE_SWEEP_SIZE: without a bound the query fetches every
  // deferred row on every tick; without ordering a cap silently re-fetches the
  // same arbitrary prefix and the tail is never reached.
  const { data: deferredRows, error: deferredErr } = await client
    .from('quiltt_webhook_inbox')
    .select('subaccount_id, platform_id')
    .is('processed_at', null)
    .not('opk_deferred_at', 'is', null)
    .order('opk_deferred_at', { ascending: true })
    .limit(REDRIVE_SWEEP_SIZE);
  if (deferredErr) {
    return { reDriven: 0, error: `deferred rows query failed: ${deferredErr.message}` };
  }
  const allSubIds = [
    ...new Set(
      (deferredRows ?? [])
        .map((r: { subaccount_id: string | null; platform_id: string | null }) => r.subaccount_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (allSubIds.length === 0) return { reDriven: 0, error: null };
  if ((deferredRows ?? []).length >= REDRIVE_SWEEP_SIZE) {
    console.warn(
      `[or-quiltt-sync] reDriveReadyDeferrals: hit REDRIVE_SWEEP_SIZE cap (${REDRIVE_SWEEP_SIZE}); ` +
        `some deferred rows were not swept this tick and will be reached on the next`,
    );
  }

  // Step 2: of those subaccounts, find which now have opk_public set.
  const { data: opkSubs, error: opkErr } = await client
    .from('subaccounts')
    .select('id')
    .in('id', allSubIds)
    .not('opk_public', 'is', null);
  if (opkErr) {
    return { reDriven: 0, error: `subaccounts OPK query failed: ${opkErr.message}` };
  }
  const opkReadyIds = (opkSubs ?? []).map((r: { id: string }) => r.id);

  // Step 2b: also re-drive subaccounts on sink platforms. Sink customers have no
  // opk_public by design and forever, so the step-2 query never surfaces them. A
  // sink subaccount's deferred events can be re-admitted as soon as its platform
  // slug is in SINK_DELIVERY_PLATFORMS -- no key registration is required (DL-0853).
  const sinkPlatformIds = [
    ...new Set(
      (deferredRows ?? [])
        .map((r: { subaccount_id: string | null; platform_id: string | null }) => r.platform_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  let sinkSubIds: string[] = [];
  if (sinkPlatformIds.length > 0) {
    const { data: sinkPlats, error: sinkPlatErr } = await client
      .from('platforms')
      .select('id')
      .in('id', sinkPlatformIds)
      .in('slug', [...SINK_DELIVERY_PLATFORMS]);
    if (sinkPlatErr) {
      return { reDriven: 0, error: `platforms sink query failed: ${sinkPlatErr.message}` };
    }
    const sinkPlatSet = new Set((sinkPlats ?? []).map((p: { id: string }) => p.id));
    sinkSubIds = [
      ...new Set(
        (deferredRows ?? [])
          .filter((r: { subaccount_id: string | null; platform_id: string | null }) =>
            r.subaccount_id !== null && r.platform_id !== null && sinkPlatSet.has(r.platform_id!)
          )
          .map((r: { subaccount_id: string | null }) => r.subaccount_id as string),
      ),
    ];
  }
  const readyIds = [...new Set([...opkReadyIds, ...sinkSubIds])];
  if (readyIds.length === 0) return { reDriven: 0, error: null };

  // Step 3: clear opk_deferred_at on their unprocessed deferred rows.
  const { count, error: clearErr } = await client
    .from('quiltt_webhook_inbox')
    .update({ opk_deferred_at: null }, { count: 'exact' })
    .in('subaccount_id', readyIds)
    .is('processed_at', null)
    .not('opk_deferred_at', 'is', null);
  if (clearErr) {
    return { reDriven: 0, error: `clear deferred rows failed: ${clearErr.message}` };
  }
  return { reDriven: count ?? 0, error: null };
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
