/**
 * or-quiltt-backlog-alert -- cron entrypoint for checkOpkDeferredBacklogAndAlert
 * (OR-T0267).
 *
 * measureOpkDeferredBacklog / checkOpkDeferredBacklogAndAlert already existed
 * (PR #1360, or-quiltt-sync/deferred-backlog.ts) and were fully unit tested,
 * but nothing on dev/prod ever called them: no HTTP route, no cron entry.
 * This function is that missing call site. It does no measurement itself --
 * it only supplies the Supabase client, the threshold and the alert channel
 * that deferred-backlog.ts already documents as its intended wiring:
 * reportError from ../_shared/sentry.ts, the same GlitchTip channel every
 * other production error in this codebase uses. No new alert channel.
 *
 * Auth: X-Internal-Worker-Token, constant-time compared to
 * OR_INTERNAL_WORKER_TOKEN. Same shape as or-quiltt-drain-alert and
 * or-queue-health: pg_cron reaches an edge function over HTTP with no user
 * JWT to present.
 *
 * Detect-and-report only, per the ticket's explicit scope: this function
 * never deletes or updates an opk_deferred_at row. deferred-backlog.ts
 * proves that itself (its fake test client has no update()/delete() method
 * at all), so nothing added here can weaken that guarantee.
 *
 * Always returns HTTP 200 with a JSON report so a breach is visible in the
 * response body too, not only in GlitchTip. A cron run is marked failed only
 * when the invocation itself failed (bad auth, missing env, a thrown error).
 *
 * Env vars:
 *   OR_INTERNAL_WORKER_TOKEN                 caller auth (required)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  standard
 *   SENTRY_DSN                               GlitchTip; reportError no-ops without it
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { reportError, wrapSentryHandler } from '../_shared/sentry.ts';
import {
  checkOpkDeferredBacklogAndAlert,
  DEFAULT_BACKLOG_THRESHOLD,
} from '../or-quiltt-sync/deferred-backlog.ts';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const callerToken = req.headers.get('X-Internal-Worker-Token');
  const expected = Deno.env.get('OR_INTERNAL_WORKER_TOKEN');
  if (!expected) return jsonResponse({ error: 'worker token not configured' }, 503);
  if (!callerToken || !timingSafeEqual(callerToken, expected)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const now = new Date();
  const breaches = await checkOpkDeferredBacklogAndAlert(
    client,
    DEFAULT_BACKLOG_THRESHOLD,
    (err) => reportError(err, 'or-quiltt-backlog-alert', req),
    now,
  );

  if (breaches.length > 0) {
    console.error(
      `[or-quiltt-backlog-alert] ${breaches.length} subaccount(s) past threshold ` +
        `(${DEFAULT_BACKLOG_THRESHOLD.maxCount} rows / ${DEFAULT_BACKLOG_THRESHOLD.maxAgeDays}d): ` +
        breaches.map((b) => `${b.subaccount_id} (${b.deferred_count} rows, ${b.age_days.toFixed(1)}d)`).join(', '),
    );
  }

  return jsonResponse(
    {
      checked_at: now.toISOString(),
      threshold: DEFAULT_BACKLOG_THRESHOLD,
      breach_count: breaches.length,
      breaches,
    },
    200,
  );
}, 'or-quiltt-backlog-alert'));
