/**
 * or-quiltt-drain-alert -- three-signal health check for or_quiltt_sync_drain
 *
 * Signals (DL-0640):
 *   A. Failure rate: >10% of or_quiltt_sync_drain runs failed in last 30 min.
 *      Reads cron.job_run_details via drain_cron_job_stats() SECURITY DEFINER RPC.
 *      Fires only when at least one run occurred (total_count > 0), so a quiet
 *      period does not produce false positives.
 *   B. Zero completions: 0 succeeded runs of or_quiltt_sync_drain in last 60 min.
 *      Same RPC as signal A. Fires when succeeded_count === 0 for the window.
 *   C. Queue stall: any quiltt_webhook_inbox row that is unprocessed (processed_at
 *      IS NULL), not retired (retirement_reason IS NULL), and older than 2 hours.
 *      Direct table query; no cron schema bridge needed.
 *
 * Auth: X-Internal-Worker-Token header, constant-time compared to OR_INTERNAL_WORKER_TOKEN.
 * Query errors surface as alert_firing = true (absence of evidence is not green).
 * Returns HTTP 200 always with a JSON health report.
 * When alert_firing, POSTs to Zulip #Delivery mentioning CTO Rails and SRE.
 * Repost suppression: when firing continuously, posts at most once per
 * SUPPRESSION_COOLDOWN_MINUTES (60 min, ~6 posts/day instead of 144).
 * zulip_post_sent in the report reflects whether the post actually went out.
 *
 * Env vars:
 *   OR_INTERNAL_WORKER_TOKEN  -- caller auth (required)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY -- standard
 *   ZULIP_BOT_EMAIL           -- Zulip bot email for alert posting
 *   ZULIP_API_KEY             -- Zulip bot API key
 *   ZULIP_API_URL             -- Zulip server base URL
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const FAILURE_WINDOW_MINUTES      = 30;
const SUCCESS_WINDOW_MINUTES      = 60;
const FAILURE_RATE_THRESHOLD      = 0.10; // 10%
const STALL_HOURS                 = 2;
const SUPPRESSION_COOLDOWN_MINUTES = 60;

interface DrainCronStats {
  failed_count:    number;
  total_count:     number;
  succeeded_count: number;
}

interface HealthReport {
  checked_at:      string;
  alert_firing:    boolean;
  /** true = Zulip post sent this run; false = suppressed or env vars missing; null = not firing */
  zulip_post_sent: boolean | null;
  error?:          string;
  signals: {
    failure_rate: {
      failed:         number | null;
      total:          number | null;
      rate:           number | null;
      threshold:      number;
      window_minutes: number;
      firing:         boolean;
    };
    zero_completions: {
      succeeded_in_window: number | null;
      window_minutes:      number;
      firing:              boolean;
    };
    queue_stall: {
      stalled_rows: number | null;
      stall_hours:  number;
      firing:       boolean;
    };
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns true if the message was sent successfully, false otherwise. */
async function postZulipAlert(message: string): Promise<boolean> {
  const botEmail = Deno.env.get('ZULIP_BOT_EMAIL');
  const apiKey   = Deno.env.get('ZULIP_API_KEY');
  const apiUrl   = Deno.env.get('ZULIP_API_URL');

  if (!botEmail || !apiKey || !apiUrl) {
    console.error('[or-quiltt-drain-alert] Zulip env vars missing; alert not posted to chat');
    return false;
  }

  const credentials = btoa(`${botEmail}:${apiKey}`);
  const params = new URLSearchParams({
    type:    'stream',
    to:      'Delivery',
    topic:   'or_quiltt_sync_drain alerting (DL-0640)',
    content: message,
  });

  try {
    const res = await fetch(`${apiUrl}/api/v1/messages`, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[or-quiltt-drain-alert] Zulip post failed (${res.status}): ${text.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[or-quiltt-drain-alert] Zulip post threw:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
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

  // Signals A + B: cron.job_run_details via SECURITY DEFINER RPC.
  // cron schema is not accessible via PostgREST; bridge function created by migration.
  const { data: statsData, error: statsErr } = await client.rpc(
    'drain_cron_job_stats',
    {
      failure_window_minutes: FAILURE_WINDOW_MINUTES,
      success_window_minutes: SUCCESS_WINDOW_MINUTES,
    },
  );

  if (statsErr) {
    console.error('[or-quiltt-drain-alert] drain_cron_job_stats RPC failed:', statsErr.message);
  }

  const stats: DrainCronStats | null = statsData ?? null;

  const failedCount:    number | null = stats?.failed_count    ?? null;
  const totalCount:     number | null = stats?.total_count     ?? null;
  const succeededCount: number | null = stats?.succeeded_count ?? null;

  // Signal A: failure rate > 10% over last 30 min.
  // Only fires when at least one run has occurred (totalCount > 0).
  const failureRate: number | null =
    (failedCount !== null && totalCount !== null && totalCount > 0)
      ? failedCount / totalCount
      : null;
  const failureRateFiring = failureRate !== null && failureRate > FAILURE_RATE_THRESHOLD;

  // Signal B: zero completions in last 60 min.
  // Fires when succeeded_count is 0 (drain ran but never succeeded, or never ran at all).
  const zeroCompletionsFiring = succeededCount !== null && succeededCount === 0;

  // Signal C: queue stall -- unprocessed, non-retired rows older than STALL_HOURS.
  // Direct Supabase query; no cron bridge needed.
  const stallCutoff = new Date(Date.now() - STALL_HOURS * 60 * 60 * 1000).toISOString();
  const { count: stalledCount, error: stallErr } = await client
    .from('quiltt_webhook_inbox')
    .select('*', { count: 'exact', head: true })
    .is('processed_at', null)
    .is('retirement_reason', null)
    .lt('received_at', stallCutoff);

  if (stallErr) {
    console.error('[or-quiltt-drain-alert] signal C (queue stall) query failed:', stallErr.message);
  }

  const stalled:    number | null = stalledCount ?? null;
  const stallFiring               = stalled !== null && stalled > 0;

  // Surface query errors: a probe that cannot run must not exit green.
  const queryErrors: string[] = [];
  if (statsErr) queryErrors.push(`signals A+B (cron stats): ${statsErr.message}`);
  if (stallErr) queryErrors.push(`signal C (queue stall): ${stallErr.message}`);
  const queryError = queryErrors.length > 0 ? queryErrors.join('; ') : undefined;

  if (failureRateFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal A (failure rate): ` +
      `${failedCount}/${totalCount} runs failed ` +
      `(${((failureRate ?? 0) * 100).toFixed(1)}%) in past ${FAILURE_WINDOW_MINUTES} min`,
    );
  }
  if (zeroCompletionsFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal B (zero completions): ` +
      `0 succeeded runs of or_quiltt_sync_drain in past ${SUCCESS_WINDOW_MINUTES} min`,
    );
  }
  if (stallFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal C (queue stall): ` +
      `${stalled} unprocessed row(s) older than ${STALL_HOURS}h`,
    );
  }

  const alertFiring = failureRateFiring || zeroCompletionsFiring || stallFiring ||
    queryError !== undefined;

  // zulip_post_sent: null when not firing, true/false when firing based on outcome.
  let zulipPostSent: boolean | null = null;

  if (alertFiring) {
    // Suppression: only post if we have never posted, or cooldown has elapsed.
    // Prevents ~144 posts/day (every 10 min) when alerts fire continuously.
    const { data: stateRow } = await client
      .from('drain_alert_state')
      .select('last_notified_at')
      .eq('id', 1)
      .maybeSingle();

    const lastNotifiedAt: string | null = stateRow?.last_notified_at ?? null;
    const cooldownMs   = SUPPRESSION_COOLDOWN_MINUTES * 60 * 1000;
    const withinCooldown =
      lastNotifiedAt !== null &&
      Date.now() - new Date(lastNotifiedAt).getTime() < cooldownMs;

    if (withinCooldown) {
      console.log(
        `[or-quiltt-drain-alert] alert firing but suppressed ` +
        `(last post: ${lastNotifiedAt}, cooldown: ${SUPPRESSION_COOLDOWN_MINUTES} min)`,
      );
      zulipPostSent = false;
    } else {
      const parts: string[] = [];
      if (failureRateFiring) {
        parts.push(
          `:x: **Signal A (failure rate):** ${failedCount}/${totalCount} drain runs failed ` +
          `(${((failureRate ?? 0) * 100).toFixed(1)}%) in the last ${FAILURE_WINDOW_MINUTES} min`,
        );
      }
      if (zeroCompletionsFiring) {
        parts.push(
          `:x: **Signal B (zero completions):** 0 succeeded runs in the last ` +
          `${SUCCESS_WINDOW_MINUTES} min`,
        );
      }
      if (stallFiring) {
        parts.push(
          `:x: **Signal C (queue stall):** ${stalled} unprocessed row(s) older than ` +
          `${STALL_HOURS}h`,
        );
      }
      if (queryError) {
        parts.push(`:warning: **Query error (probe could not run):** ${queryError}`);
      }

      const message =
        `:warning: **or_quiltt_sync_drain alert** @**CTO Rails** @**SRE**\n\n` +
        parts.join('\n') +
        `\n\nChecked at: ${checkedAt}`;

      zulipPostSent = await postZulipAlert(message);

      if (zulipPostSent) {
        // Update suppression state so next run within cooldown is skipped.
        await client
          .from('drain_alert_state')
          .upsert({ id: 1, last_notified_at: checkedAt });
      }
    }
  }

  const report: HealthReport = {
    checked_at:      checkedAt,
    alert_firing:    alertFiring,
    zulip_post_sent: zulipPostSent,
    ...(queryError !== undefined ? { error: queryError } : {}),
    signals: {
      failure_rate: {
        failed:         failedCount,
        total:          totalCount,
        rate:           failureRate,
        threshold:      FAILURE_RATE_THRESHOLD,
        window_minutes: FAILURE_WINDOW_MINUTES,
        firing:         failureRateFiring,
      },
      zero_completions: {
        succeeded_in_window: succeededCount,
        window_minutes:      SUCCESS_WINDOW_MINUTES,
        firing:              zeroCompletionsFiring,
      },
      queue_stall: {
        stalled_rows: stalled,
        stall_hours:  STALL_HOURS,
        firing:       stallFiring,
      },
    },
  };

  return new Response(JSON.stringify(report), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
}, 'or-quiltt-drain-alert'));
