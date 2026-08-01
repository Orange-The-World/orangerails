/**
 * or-quiltt-inbox-alert -- three-signal health check for quiltt_webhook_inbox
 *
 * Signals (GH-385):
 *   1. Depth: unprocessed row count > DEPTH_THRESHOLD (default 50, tunable via env).
 *   2. Staleness: oldest unprocessed row received_at older than STALE_MINUTES (default 60).
 *      Queries the oldest received_at WHERE processed_at IS NULL. NULL result means inbox
 *      is empty, genuine green. This signal cannot silently pass stale rows even when
 *      max(processed_at) is NULL (nothing yet processed): if unprocessed rows exist, their
 *      received_at is a real timestamp checked against the threshold.
 *   3. pg_cron: any status='failed' in cron.job_run_details for or_quiltt_sync_drain
 *      in the past CRON_WINDOW_MINUTES (default 60). Queries via
 *      public.quiltt_sync_cron_failures() RPC (SECURITY DEFINER, cron schema not
 *      accessible via PostgREST directly).
 *
 * Auth: X-Internal-Worker-Token header, constant-time compared to OR_INTERNAL_WORKER_TOKEN.
 * This endpoint is for OR ops and cron only; not callable from integrators or browsers.
 *
 * Returns HTTP 200 always with a JSON health report. Logs console.error for each firing
 * signal so failures are visible in Supabase function logs.
 *
 * Env vars:
 *   OR_INTERNAL_WORKER_TOKEN        -- caller auth (required)
 *   SUPABASE_URL                    -- standard
 *   SUPABASE_SERVICE_ROLE_KEY       -- standard
 *   QUILTT_ALERT_DEPTH_THRESHOLD    -- optional, default 50
 *   QUILTT_ALERT_STALE_MINUTES      -- optional, default 60
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const DEPTH_THRESHOLD     = parseInt(Deno.env.get('QUILTT_ALERT_DEPTH_THRESHOLD') ?? '50', 10);
const STALE_MINUTES       = parseInt(Deno.env.get('QUILTT_ALERT_STALE_MINUTES') ?? '60', 10);
const CRON_WINDOW_MINUTES = 60;

interface HealthReport {
  checked_at:   string;
  alert_firing: boolean;
  error?:       string;
  signals: {
    depth: {
      value:     number | null;
      threshold: number;
      firing:    boolean;
    };
    staleness: {
      oldest_unprocessed_at: string | null;
      stale_minutes:         number;
      firing:                boolean;
      note?:                 string;
    };
    cron_failures: {
      failed_runs_in_window: number | null;
      window_minutes:        number;
      firing:                boolean;
    };
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const callerToken = req.headers.get('X-Internal-Worker-Token');
  const expected    = Deno.env.get('OR_INTERNAL_WORKER_TOKEN');
  if (!expected)     return new Response('worker token not configured', { status: 503 });
  if (!callerToken || !timingSafeEqual(callerToken, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const checkedAt = new Date().toISOString();

  // Signal 1: depth (unprocessed row count)
  const { count: depthCount, error: depthErr } = await client
    .from('quiltt_webhook_inbox')
    .select('*', { count: 'exact', head: true })
    .is('processed_at', null);

  if (depthErr) {
    console.error('[or-quiltt-inbox-alert] signal 1 (depth) query failed:', depthErr.message);
  }

  const depth = depthCount ?? null;
  const depthFiring = depth !== null && depth > DEPTH_THRESHOLD;

  // Signal 2: staleness (oldest unprocessed row).
  // Selects the row with the smallest received_at WHERE processed_at IS NULL,
  // equivalent to min(received_at) with the same NULL-safety property:
  //   - No unprocessed rows -> empty result -> oldestAt = null -> green.
  //   - Unprocessed rows exist -> oldest received_at -> checked for staleness.
  // This fires correctly when max(processed_at) is NULL (nothing yet processed):
  // unprocessed rows are present and their received_at is the real evidence.
  const { data: oldestRows, error: oldestErr } = await client
    .from('quiltt_webhook_inbox')
    .select('received_at')
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(1);

  if (oldestErr) {
    console.error('[or-quiltt-inbox-alert] signal 2 (staleness) query failed:', oldestErr.message);
  }

  const oldestAt: string | null = (oldestRows && oldestRows.length > 0)
    ? oldestRows[0].received_at
    : null;

  let stalenessFiring = false;
  let stalenessNote: string | undefined;

  if (oldestAt === null && !oldestErr) {
    stalenessNote = 'inbox empty, no unprocessed rows';
  } else {
    const ageMs = Date.now() - new Date(oldestAt).getTime();
    stalenessFiring = ageMs > STALE_MINUTES * 60 * 1000;
  }

  // Signal 3: pg_cron failures for or_quiltt_sync_drain.
  // Calls public.quiltt_sync_cron_failures() (SECURITY DEFINER) because
  // cron.job_run_details is not in the public schema and not accessible via PostgREST.
  // Function is created by migration 20260801000000_schedule_or_quiltt_inbox_alert.sql.
  const { data: cronData, error: cronErr } = await client.rpc(
    'quiltt_sync_cron_failures',
    { window_minutes: CRON_WINDOW_MINUTES },
  );

  if (cronErr) {
    console.error('[or-quiltt-inbox-alert] signal 3 (pg_cron) query failed:', cronErr.message);
  }

  const failedRuns: number | null = cronData !== null && cronData !== undefined
    ? Number(cronData)
    : null;
  const cronFiring = failedRuns !== null && failedRuns > 0;

  // Surface query errors so connectivity failures are reported unhealthy, not false-green.
  // Absence of evidence (null from a failed query) is not evidence of absence.
  const queryErrors: string[] = [];
  if (depthErr)  queryErrors.push(`signal 1 (depth): ${depthErr.message}`);
  if (oldestErr) queryErrors.push(`signal 2 (staleness): ${oldestErr.message}`);
  if (cronErr)   queryErrors.push(`signal 3 (pg_cron): ${cronErr.message}`);
  const queryError = queryErrors.length > 0 ? queryErrors.join('; ') : undefined;

  // Log each firing signal as an error visible in Supabase function logs.
  if (depthFiring) {
    console.error(
      `[or-quiltt-inbox-alert] ALERT signal 1 (depth): ${depth} unprocessed rows exceeds threshold ${DEPTH_THRESHOLD}`,
    );
  }
  if (stalenessFiring) {
    console.error(
      `[or-quiltt-inbox-alert] ALERT signal 2 (staleness): oldest unprocessed row received at ${oldestAt}, older than ${STALE_MINUTES} minutes`,
    );
  }
  if (cronFiring) {
    console.error(
      `[or-quiltt-inbox-alert] ALERT signal 3 (pg_cron): ${failedRuns} failed run(s) for or_quiltt_sync_drain in past ${CRON_WINDOW_MINUTES} minutes`,
    );
  }

  const alertFiring = depthFiring || stalenessFiring || cronFiring || queryError !== undefined;

  const report: HealthReport = {
    checked_at:   checkedAt,
    alert_firing: alertFiring,
    ...(queryError !== undefined ? { error: queryError } : {}),
    signals: {
      depth: {
        value:     depth,
        threshold: DEPTH_THRESHOLD,
        firing:    depthFiring,
      },
      staleness: {
        oldest_unprocessed_at: oldestAt,
        stale_minutes:         STALE_MINUTES,
        firing:                stalenessFiring,
        ...(stalenessNote !== undefined ? { note: stalenessNote } : {}),
      },
      cron_failures: {
        failed_runs_in_window: failedRuns,
        window_minutes:        CRON_WINDOW_MINUTES,
        firing:                cronFiring,
      },
    },
  };

  return new Response(JSON.stringify(report), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}, 'or-quiltt-inbox-alert'));
