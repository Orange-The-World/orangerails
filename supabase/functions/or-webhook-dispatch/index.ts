/**
 * or-webhook-dispatch , drains the webhook_delivery queue.
 *
 * Invoked every minute by pg_cron via public.invoke_or_webhook_dispatch().
 * Migration: 20260824120000_schedule_or_webhook_dispatch.sql.
 *
 * Until that migration this header read "Cron-eligible. Invoke on a schedule",
 * which was an instruction to a future operator rather than a description of
 * anything. Nobody carried it out, so the queue accumulated 52 rows at
 * attempts = 0 between 11 June and 24 August while every dashboard looked
 * healthy. If you are tempted to leave a similar note in a header, wire it
 * instead.
 *
 * Auth: POST only, and requires X-Internal-Worker-Token matching the Vault
 * secret or_internal_worker_token. Operators and tests can call it by hand
 * with that header.
 *
 * What it does, every invocation:
 *   1. SELECT * FROM webhook_delivery
 *      WHERE succeeded_at IS NULL
 *        AND attempts < MAX_ATTEMPTS
 *      ORDER BY created_at ASC
 *      LIMIT BATCH_SIZE
 *   2. For each row, in order, unless the breaker has already tripped this
 *      invocation (see below):
 *        - Skip if last_attempt_at is younger than the backoff window
 *          (min(60s * 2^attempts, 1h)). This is the exponential-backoff
 *          schedule from the AC: 1m, 2m, 4m, 8m, 16m for attempts 0..4.
 *        - Look up platforms.webhook_url + platforms.webhook_secret.
 *          If either is NULL, mark the row "abandoned" (succeeded_at = now())
 *          so we don't keep retrying a row whose target was deleted.
 *        - Serialize the payload to JSON; compute
 *            X-OR-Signature: HMAC-SHA-256(webhook_secret, body), hex
 *        - POST body with that header + Content-Type: application/json.
 *        - On HTTP 2xx → succeeded_at = now()
 *        - On any other outcome → attempts += 1, last_attempt_at = now(),
 *          last_error = short string ("HTTP 500" / "fetch failed" / etc.)
 *
 * Circuit breaker (OR-T0335). On 2026-08-12 13:43-14:08 EDT a single
 * systemic database write failure was retried and retired 40 events across
 * 6 platforms one row at a time, indistinguishable from 40 unrelated bad
 * rows, with no alert until every row had aged past its own attempt cap.
 * Many deliveries failing for the exact same reason in one scan is a broken
 * deployment or a downstream outage, not that many unrelated bad rows, so:
 * when FAILURE_STREAK_THRESHOLD (3) deliveries in this invocation fail with
 * the identical error text, processing stops for the rest of the batch (no
 * attempts bump on those remaining rows, so each stays exactly as retryable
 * as it was before this tick) and onBreakerTrip pages a human via the
 * existing GlitchTip path instead of letting the queue silently drain
 * itself down to nothing. A lone row failing for its own distinct reason
 * among healthy rows never reaches the threshold and is still retired
 * normally , the breaker does not replace one failure mode with another.
 *
 * Signature contract (documented for consumers , v1 + v2 in parallel):
 *
 *   v1 (legacy, retained for back-compat during the transition window):
 *     X-OR-Signature: hex(HMAC-SHA256(webhook_secret_utf8, raw_body_utf8))
 *
 *   v2 (preferred, ship after 2026-05-23):
 *     X-OR-Signature-V2: t=<unix_ts>,v1=<hex_sig>
 *       where hex_sig = HMAC-SHA256(webhook_secret_utf8,
 *                                   "<unix_ts>.<raw_body_utf8>")
 *     X-OR-Event-Id:    <uuid>   (stable across retries; consumers dedupe on this)
 *
 *   v2 defends against naive replay attacks (the timestamp is inside
 *   the signed material) and gives consumers a free idempotency key.
 *   The @orangerails/webhooks npm package prefers v2 and falls back
 *   to v1 , once all consumers are on the SDK, v1 will be removed.
 *
 *   Consumers verify by recomputing the HMAC over the raw request body
 *   (v1) or "<ts>.<body>" (v2) with their copy of the secret and
 *   comparing in constant time. The secret is a 32-byte random hex
 *   string (64 chars) provisioned per platform; rotate by issuing a
 *   new secret and updating the platforms row.
 *
 * Event payload (event_type = "sync.completed"):
 *   {
 *     event:         "sync.completed",
 *     subaccount_id: "<uuid>",
 *     connection_id: "<uuid>",
 *     synced_count:  <int>,
 *     ts:            "<ISO-8601>"
 *   }
 *
 * Retries cap at MAX_ATTEMPTS (5). After that the row is left as-is
 * (succeeded_at NULL, attempts = 5) for ops triage; the partial index
 * idx_webhook_delivery_pending ignores it from then on so it does not
 * weigh on the queue scan.
 *
 * No auth / no CORS , operator + cron only. Anonymous browser callers
 * cannot drain other platforms' queues because the function only
 * looks at platform-owned rows and never returns payload contents in
 * the response (just a count).
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { jsonResponse } from '../_shared/http.ts';
import { reportError, wrapSentryHandler } from '../_shared/sentry.ts';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const BACKOFF_BASE_SECONDS = 60;   // 1 minute
const BACKOFF_MAX_SECONDS = 3600;  // 1 hour

// Three deliveries failing with the exact same error text in one batch is
// not three unrelated bad rows, it is one cause wearing three faces: a dead
// downstream host, a broken deploy, or a bad secret rotation all produce
// this shape, and a flaky integrator endpoint does not, because its
// failures are spread across ticks and mixed in with other platforms'
// distinct errors. Set low enough to trip inside a single BATCH_SIZE=50
// scan so "in the same minute" is literal rather than eventual, and above
// two so a pair of platforms coincidentally blipping on the same tick
// cannot trip it alone.
const FAILURE_STREAK_THRESHOLD = 3;

interface DeliveryRow {
  id: string;
  platform_id: string;
  subaccount_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_attempt_at: string | null;
  /** v2 wire format: stable UUID surfaced as X-OR-Event-Id for consumer dedupe. */
  event_id: string;
}

interface PlatformRow {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

/**
 * Compute hex-encoded HMAC-SHA-256 of `body` keyed by `secret`.
 * Exported for the test file in this directory.
 */
export async function computeSignature(secret: string, body: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body) as BufferSource,
  );
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns true if `row.last_attempt_at` is older than the exponential
 * backoff window for its current `attempts` count. attempts=0 is always
 * eligible (a fresh row that has never been tried).
 */
export function isBackoffElapsed(
  row: { attempts: number; last_attempt_at: string | null },
  now: Date = new Date(),
): boolean {
  if (!row.last_attempt_at || row.attempts === 0) return true;
  const windowSeconds = Math.min(
    BACKOFF_BASE_SECONDS * 2 ** row.attempts,
    BACKOFF_MAX_SECONDS,
  );
  const last = new Date(row.last_attempt_at).getTime();
  return now.getTime() - last >= windowSeconds * 1000;
}

/** What onBreakerTrip receives when the same failure fires the breaker. */
export interface BreakerTripInfo {
  /** The exact error text shared by every failure that tripped the breaker. */
  reason: string;
  /** How many deliveries had already failed with that text when it tripped. */
  failureCount: number;
  /** Rows left completely untouched (no attempts bump) once it tripped. */
  remainingSkipped: number;
}

/**
 * Default paging path: report to GlitchTip via the same reportError() used
 * for uncaught exceptions elsewhere in this codebase, so it lands wherever
 * that is already monitored. Kept separate from onBreakerTrip's call site
 * so tests can inject a mock and assert a page fired with no network call.
 */
async function defaultOnBreakerTrip(info: BreakerTripInfo): Promise<void> {
  await reportError(
    new Error(
      `or-webhook-dispatch circuit breaker tripped: ${info.failureCount} deliveries failed ` +
        `identically ("${info.reason}") in one batch. ${info.remainingSkipped} remaining row(s) ` +
        'were left untouched for the next tick instead of being retried toward their own ' +
        'attempt cap. This is the shape of a broken deployment or a downstream outage, not ' +
        'unrelated bad rows.',
    ),
    'or-webhook-dispatch',
  );
}

interface DispatchDeps {
  serviceClient: SupabaseClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Called once, at most, if the breaker trips. Defaults to paging via
   * GlitchTip (defaultOnBreakerTrip). Injected so tests can assert a page
   * fired without making a real network call, mirroring fetchImpl/now.
   */
  onBreakerTrip?: (info: BreakerTripInfo) => Promise<void> | void;
}

interface DispatchResult {
  scanned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped_backoff: number;
  abandoned: number;
  /** Rows left untouched because the breaker had already tripped this invocation. */
  skipped_breaker: number;
  breaker_tripped: boolean;
  breaker_reason: string | null;
}

/**
 * Drain one batch from the queue. Returns counts for observability.
 * Pulled out as a pure function so tests can drive it with a mock
 * Supabase client + a mock fetch.
 */
export async function dispatchBatch(deps: DispatchDeps): Promise<DispatchResult> {
  const { serviceClient } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const onBreakerTrip = deps.onBreakerTrip ?? defaultOnBreakerTrip;

  const result: DispatchResult = {
    scanned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped_backoff: 0,
    abandoned: 0,
    skipped_breaker: 0,
    breaker_tripped: false,
    breaker_reason: null,
  };

  // deno-lint-ignore no-explicit-any
  const sb = serviceClient as any;
  const { data: rows, error: rowsErr } = await sb
    .from('webhook_delivery')
    .select('id, platform_id, subaccount_id, event_type, payload, attempts, last_attempt_at, event_id')
    .is('succeeded_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (rowsErr) throw rowsErr;
  const pending = (rows ?? []) as DeliveryRow[];
  result.scanned = pending.length;
  if (pending.length === 0) return result;

  // Resolve platform rows in one query.
  const platformIds = Array.from(new Set(pending.map((r) => r.platform_id)));
  const { data: platforms, error: pErr } = await sb
    .from('platforms')
    .select('id, webhook_url, webhook_secret')
    .in('id', platformIds);
  if (pErr) throw pErr;
  const platformById = new Map<string, PlatformRow>(
    ((platforms ?? []) as PlatformRow[]).map((p) => [p.id, p]),
  );

  // Failures in THIS invocation only, grouped by their exact error text.
  // Not persisted: a breaker that stays tripped across ticks would need an
  // explicit reset path and ops visibility into that state, which is more
  // machinery than "stop making today worse and page someone" needs. Each
  // tick starts the count fresh, so a genuinely ongoing outage keeps
  // tripping (and keeps paging) every minute until it clears or the
  // rows are drained by hand, and a one-tick blip does not leave anything
  // wedged.
  const failureCounts = new Map<string, number>();
  let breakerTripInfo: { reason: string; failureCount: number } | null = null;

  for (const row of pending) {
    if (breakerTripInfo) {
      // The breaker already tripped on an earlier row in this same batch.
      // Leave this row completely untouched: no attempts bump, no
      // last_attempt_at, so it stays exactly as retryable as it was
      // before this invocation started.
      result.skipped_breaker += 1;
      continue;
    }

    if (!isBackoffElapsed(row, now())) {
      result.skipped_backoff += 1;
      continue;
    }

    const plat = platformById.get(row.platform_id);
    if (!plat || !plat.webhook_url || !plat.webhook_secret) {
      // Platform deregistered webhooks (or never had any). Don't keep
      // retrying , mark as succeeded with a sentinel error so ops can
      // tell the difference. attempts is not bumped so the row count
      // stays accurate. Deliberately not counted toward the breaker:
      // this is an expected, permanent stop, not a failure.
      await sb
        .from('webhook_delivery')
        .update({
          succeeded_at: now().toISOString(),
          last_error: 'platform_webhook_disabled',
        })
        .eq('id', row.id);
      result.abandoned += 1;
      continue;
    }

    result.attempted += 1;
    const bodyStr = JSON.stringify(row.payload);

    // v1 + v2 wire formats are emitted in parallel during the
    // transition window. Consumers MAY verify v2 (preferred) or
    // fall back to v1; the SDK at @orangerails/webhooks prefers v2.
    // v2 signs "<unix_ts>.<body>" which defeats naive replay of a
    // captured request, matching Stripe's wire format.
    const tsSeconds = Math.floor(now().getTime() / 1000);
    let signatureV1: string;
    let signatureV2Hex: string;
    try {
      signatureV1 = await computeSignature(plat.webhook_secret, bodyStr);
      signatureV2Hex = await computeSignature(
        plat.webhook_secret,
        `${tsSeconds}.${bodyStr}`,
      );
    } catch (e) {
      // Signing failure means we have a malformed secret , bump
      // attempts so we eventually give up rather than spinning.
      const msg = e instanceof Error ? e.message : String(e);
      const reason = `sign_failed: ${msg.slice(0, 200)}`;
      await sb
        .from('webhook_delivery')
        .update({
          attempts: row.attempts + 1,
          last_attempt_at: now().toISOString(),
          last_error: reason,
        })
        .eq('id', row.id);
      result.failed += 1;
      const count = (failureCounts.get(reason) ?? 0) + 1;
      failureCounts.set(reason, count);
      if (!breakerTripInfo && count >= FAILURE_STREAK_THRESHOLD) {
        breakerTripInfo = { reason, failureCount: count };
      }
      continue;
    }

    let ok = false;
    let errMsg = '';
    try {
      const resp = await fetchImpl(plat.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // v1 (legacy): consumers still verifying with the old scheme.
          'X-OR-Signature': signatureV1,
          // v2 (preferred): timestamped signature + delivery id.
          'X-OR-Signature-V2': `t=${tsSeconds},v1=${signatureV2Hex}`,
          'X-OR-Event-Id': row.event_id,
        },
        body: bodyStr,
      });
      ok = resp.status >= 200 && resp.status < 300;
      if (!ok) errMsg = `HTTP ${resp.status}`;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }

    if (ok) {
      await sb
        .from('webhook_delivery')
        .update({
          succeeded_at: now().toISOString(),
          attempts: row.attempts + 1,
          last_attempt_at: now().toISOString(),
          last_error: null,
        })
        .eq('id', row.id);
      result.succeeded += 1;
    } else {
      const reason = errMsg.slice(0, 500);
      await sb
        .from('webhook_delivery')
        .update({
          attempts: row.attempts + 1,
          last_attempt_at: now().toISOString(),
          last_error: reason,
        })
        .eq('id', row.id);
      result.failed += 1;
      const count = (failureCounts.get(reason) ?? 0) + 1;
      failureCounts.set(reason, count);
      if (!breakerTripInfo && count >= FAILURE_STREAK_THRESHOLD) {
        breakerTripInfo = { reason, failureCount: count };
      }
    }
  }

  if (breakerTripInfo) {
    result.breaker_tripped = true;
    result.breaker_reason = breakerTripInfo.reason;
    await onBreakerTrip({
      reason: breakerTripInfo.reason,
      failureCount: breakerTripInfo.failureCount,
      remainingSkipped: result.skipped_breaker,
    });
  }

  return result;
}

/**
 * Constant-time string compare. Same implementation as or-quiltt-sync's, kept
 * local rather than shared because copying nine lines is cheaper than a new
 * shared module in the _shared barrel for one caller each.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const serviceClient = makeServiceClient();

    // Caller auth. This function drains a queue and sends signed payloads to
    // integrator endpoints, so it must not be invocable by anyone who can
    // reach the URL. It previously took no request at all (the handler
    // signature was `_req`), which was safe only because the function had no
    // config.toml entry and therefore inherited verify_jwt = true. Wiring it
    // to pg_cron means it now needs verify_jwt = false, so the platform gate
    // goes away and this guard replaces it. Same shape as or-quiltt-sync.
    //
    // The token is read through get_or_internal_worker_token() rather than
    // straight from vault: the vault schema is not exposed over PostgREST in
    // the deployed edge runtime (DL-0599), so a direct read fails at runtime
    // while working locally.
    const callerToken = req.headers.get('X-Internal-Worker-Token');
    // deno-lint-ignore no-explicit-any
    const { data: expected, error: vaultErr } = await (serviceClient as any)
      .rpc('get_or_internal_worker_token');
    if (vaultErr) {
      console.error('[or-webhook-dispatch] vault RPC failed:', vaultErr.code, vaultErr.message);
      return jsonResponse({ error: 'vault read error' }, 503);
    }
    if (!expected) {
      return jsonResponse({ error: 'worker token missing from vault' }, 503);
    }
    if (!callerToken || !timingSafeEqual(callerToken, expected)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const result = await dispatchBatch({ serviceClient });
    return jsonResponse(result, 200);
  } catch (err) {
    console.error('[or-webhook-dispatch] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500);
  }
}, 'or-webhook-dispatch'));
