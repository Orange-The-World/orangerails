/**
 * or-webhook-dispatch — drains the webhook_delivery queue.
 *
 * Cron-eligible. Invoke on a schedule (every 30-60s) via Supabase
 * Cron or any external scheduler. Also accepts a manual POST trigger
 * (no body required) for operators / tests.
 *
 * What it does, every invocation:
 *   1. SELECT * FROM webhook_delivery
 *      WHERE succeeded_at IS NULL
 *        AND attempts < MAX_ATTEMPTS
 *      ORDER BY created_at ASC
 *      LIMIT BATCH_SIZE
 *   2. For each row:
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
 * Signature contract (documented for consumers — v1 + v2 in parallel):
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
 *   to v1 — once all consumers are on the SDK, v1 will be removed.
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
 * No auth / no CORS — operator + cron only. Anonymous browser callers
 * cannot drain other platforms' queues because the function only
 * looks at platform-owned rows and never returns payload contents in
 * the response (just a count).
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from '../_shared/http.ts';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const BACKOFF_BASE_SECONDS = 60;   // 1 minute
const BACKOFF_MAX_SECONDS = 3600;  // 1 hour

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

interface DispatchDeps {
  serviceClient: SupabaseClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface DispatchResult {
  scanned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped_backoff: number;
  abandoned: number;
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

  const result: DispatchResult = {
    scanned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped_backoff: 0,
    abandoned: 0,
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

  for (const row of pending) {
    if (!isBackoffElapsed(row, now())) {
      result.skipped_backoff += 1;
      continue;
    }

    const plat = platformById.get(row.platform_id);
    if (!plat || !plat.webhook_url || !plat.webhook_secret) {
      // Platform deregistered webhooks (or never had any). Don't keep
      // retrying — mark as succeeded with a sentinel error so ops can
      // tell the difference. attempts is not bumped so the row count
      // stays accurate.
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
      // Signing failure means we have a malformed secret — bump
      // attempts so we eventually give up rather than spinning.
      const msg = e instanceof Error ? e.message : String(e);
      await sb
        .from('webhook_delivery')
        .update({
          attempts: row.attempts + 1,
          last_attempt_at: now().toISOString(),
          last_error: `sign_failed: ${msg.slice(0, 200)}`,
        })
        .eq('id', row.id);
      result.failed += 1;
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
      await sb
        .from('webhook_delivery')
        .update({
          attempts: row.attempts + 1,
          last_attempt_at: now().toISOString(),
          last_error: errMsg.slice(0, 500),
        })
        .eq('id', row.id);
      result.failed += 1;
    }
  }

  return result;
}

Deno.serve(async (_req: Request) => {
  try {
    const serviceClient = makeServiceClient();
    const result = await dispatchBatch({ serviceClient });
    return jsonResponse(result, 200);
  } catch (err) {
    console.error('[or-webhook-dispatch] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500);
  }
});
