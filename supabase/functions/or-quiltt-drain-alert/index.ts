/**
 * or-quiltt-drain-alert -- five-signal health check for or_quiltt_sync_drain
 *
 * Signals (DL-0640, signal D added by DL-1540, signal E added by OR-T1667):
 *   A. Failure rate: >10% of or_quiltt_sync_drain runs failed in last 30 min.
 *      Reads cron.job_run_details via drain_cron_job_stats() SECURITY DEFINER RPC.
 *      Fires only when at least one run occurred (total_count > 0), so a quiet
 *      period does not produce false positives.
 *   B. Zero completions: 0 succeeded runs of or_quiltt_sync_drain in last 60 min.
 *      Same RPC as signal A. Fires when succeeded_count === 0 for the window.
 *   C. Queue stall: any quiltt_webhook_inbox row that is unprocessed (processed_at
 *      IS NULL), not retired (retirement_reason IS NULL), and older than 2 hours.
 *      Direct table query; no cron schema bridge needed.
 *   D. Retired events: any quiltt_webhook_inbox row retired (retirement_reason
 *      IS NOT NULL) in the last 24 hours. A retirement is a webhook this system
 *      received, failed to handle MAX_ATTEMPTS times, and then DESTROYED. The
 *      customer's bank told us something and we threw it away.
 *
 *      This signal exists because signals A to C were all green for ten weeks
 *      while 246 events were destroyed. None of them can see a retirement:
 *      A and B watch whether the drain JOB runs, which it does, successfully;
 *      and C cannot fire because bumpAttempts stamps processed_at at the same
 *      moment it stamps retirement_reason, so a destroyed event is
 *      indistinguishable from a delivered one by every column C looks at.
 *      Signal C also excludes retired rows explicitly. Retirement was invisible
 *      by construction, not by accident.
 *
 *      Threshold is deliberately > 0 rather than a rate. Losing a customer's
 *      bank data is not a thing that has an acceptable background level.
 *   E. Deferred-inbox backlog: rows with opk_deferred_at set and processed_at
 *      still null. reDriveReadyDeferrals in or-quiltt-sync re-admits a deferred
 *      row once its subaccount registers an OPK, and the drain runs every
 *      minute; nothing watched this number before, so if that re-drive ever
 *      stopped working the backlog would grow with no alarm. Fires when the
 *      count exceeds DEFERRED_BACKLOG_THRESHOLD, or the oldest deferred row
 *      exceeds DEFERRED_BACKLOG_AGE_HOURS: one stuck subaccount and twenty
 *      are different incidents, so both the count and the age are reported.
 *      Thresholds are justified on OR-T0250 against a measured arrival rate
 *      of about one a day. This is a read only signal: no purge, delete or
 *      retention behaviour is added anywhere by this file. A deferred row is
 *      a real unprocessed customer webhook and must never be deleted.
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
const RETIREMENT_WINDOW_HOURS     = 24;
const DEFERRED_BACKLOG_THRESHOLD  = 25;
const DEFERRED_BACKLOG_AGE_HOURS  = 24;
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
    retired_events: {
      retired_rows:  number | null;
      window_hours:  number;
      firing:        boolean;
    };
    deferred_backlog: {
      deferred_unprocessed: number | null;
      oldest_age_hours:     number | null;
      subaccounts:          number | null;
      count_threshold:      number;
      age_threshold_hours:  number;
      firing:               boolean;
    };
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ZulipPostResult {
  sent: boolean;
  /** Short reason for a failure. Undefined when sent is true. */
  error?: string;
}

/** Attempts to post to Zulip. Never throws: every failure path returns a reason
 *  short enough to store in drain_alert_state.last_error. */
async function postZulipAlert(message: string): Promise<ZulipPostResult> {
  const botEmail = Deno.env.get('ZULIP_BOT_EMAIL');
  const apiKey   = Deno.env.get('ZULIP_API_KEY');
  const apiUrl   = Deno.env.get('ZULIP_API_URL');

  if (!botEmail || !apiKey || !apiUrl) {
    const missing = [
      !botEmail ? 'ZULIP_BOT_EMAIL' : null,
      !apiKey   ? 'ZULIP_API_KEY'   : null,
      !apiUrl   ? 'ZULIP_API_URL'   : null,
    ].filter((v): v is string => v !== null).join(', ');
    const error = `missing env var(s): ${missing}`;
    console.error(`[or-quiltt-drain-alert] Zulip env vars missing; alert not posted to chat (${error})`);
    return { sent: false, error };
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
      const error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      console.error(`[or-quiltt-drain-alert] Zulip post failed (${res.status}): ${text.slice(0, 200)}`);
      return { sent: false, error };
    }
    return { sent: true };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    console.error('[or-quiltt-drain-alert] Zulip post threw:', error);
    return { sent: false, error };
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

  // Signal D: events retired in the last RETIREMENT_WINDOW_HOURS.
  //
  // processed_at is the retirement timestamp for a retired row: bumpAttempts
  // writes processed_at and retirement_reason in the same UPDATE when attempts
  // reach MAX_ATTEMPTS. There is no separate retired_at column, so this is the
  // honest key to window on rather than received_at, which would measure when
  // the webhook arrived instead of when we gave up on it.
  const retirementCutoff = new Date(
    Date.now() - RETIREMENT_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { count: retiredCount, error: retiredErr } = await client
    .from('quiltt_webhook_inbox')
    .select('*', { count: 'exact', head: true })
    .not('retirement_reason', 'is', null)
    .gte('processed_at', retirementCutoff);

  if (retiredErr) {
    console.error('[or-quiltt-drain-alert] signal D (retired events) query failed:', retiredErr.message);
  }

  const retired:      number | null = retiredCount ?? null;
  const retiredFiring               = retired !== null && retired > 0;

  // Signal E: deferred-inbox backlog -- rows with opk_deferred_at set and still
  // unprocessed. Computed client side from a plain select (rather than a new
  // RPC) because this ticket adds no migration: opk_deferred_at is a timestamp,
  // not a boolean, so max age and distinct subaccounts are derived here rather
  // than in a single aggregate query.
  const { data: deferredRows, error: deferredErr } = await client
    .from('quiltt_webhook_inbox')
    .select('opk_deferred_at, subaccount_id')
    .not('opk_deferred_at', 'is', null)
    .is('processed_at', null);

  if (deferredErr) {
    console.error('[or-quiltt-drain-alert] signal E (deferred backlog) query failed:', deferredErr.message);
  }

  const deferredList = deferredErr ? [] : (deferredRows ?? []);
  const deferredUnprocessed: number | null = deferredErr ? null : deferredList.length;
  const oldestAgeHours: number | null =
    (!deferredErr && deferredList.length > 0)
      ? Math.max(
          ...deferredList.map((r: { opk_deferred_at: string }) =>
            (Date.now() - new Date(r.opk_deferred_at).getTime()) / (1000 * 60 * 60),
          ),
        )
      : (deferredErr ? null : 0);
  const deferredSubaccounts: number | null =
    deferredErr
      ? null
      : new Set(deferredList.map((r: { subaccount_id: string }) => r.subaccount_id)).size;
  const deferredBacklogFiring =
    !deferredErr &&
    deferredUnprocessed !== null &&
    (deferredUnprocessed > DEFERRED_BACKLOG_THRESHOLD ||
      (oldestAgeHours !== null && oldestAgeHours > DEFERRED_BACKLOG_AGE_HOURS));

  // Surface query errors: a probe that cannot run must not exit green.
  const queryErrors: string[] = [];
  if (statsErr) queryErrors.push(`signals A+B (cron stats): ${statsErr.message}`);
  if (stallErr) queryErrors.push(`signal C (queue stall): ${stallErr.message}`);
  if (retiredErr) queryErrors.push(`signal D (retired events): ${retiredErr.message}`);
  if (deferredErr) queryErrors.push(`signal E (deferred backlog): ${deferredErr.message}`);
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

  if (retiredFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal D (retired events): ` +
      `${retired} webhook event(s) DESTROYED in past ${RETIREMENT_WINDOW_HOURS}h`,
    );
  }

  if (deferredBacklogFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal E (deferred backlog): ` +
      `${deferredUnprocessed} deferred-and-unprocessed row(s), oldest ` +
      `${(oldestAgeHours ?? 0).toFixed(1)}h, across ${deferredSubaccounts} subaccount(s)`,
    );
  }

  const alertFiring = failureRateFiring || zeroCompletionsFiring || stallFiring ||
    retiredFiring || deferredBacklogFiring || queryError !== undefined;

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
      if (retiredFiring) {
        parts.push(
          `:x: **Signal D (retired events):** ${retired} webhook event(s) DESTROYED in the last ` +
          `${RETIREMENT_WINDOW_HOURS}h. Each one is a bank sync notification we received and threw ` +
          `away. Query quiltt_webhook_inbox for retirement_reason to see why.`,
        );
      }
      if (deferredBacklogFiring) {
        parts.push(
          `:warning: **Signal E (deferred backlog):** ${deferredUnprocessed} deferred-and-unprocessed ` +
          `row(s), oldest ${(oldestAgeHours ?? 0).toFixed(1)}h, across ${deferredSubaccounts} ` +
          `subaccount(s). A deferred row is re-admitted once its subaccount registers an OPK; if ` +
          `this keeps growing the re-drive may have stopped working.`,
        );
      }
      if (queryError) {
        parts.push(`:warning: **Query error (probe could not run):** ${queryError}`);
      }

      const message =
        `:warning: **or_quiltt_sync_drain alert** @**CTO Rails** @**SRE**\n\n` +
        parts.join('\n') +
        `\n\nChecked at: ${checkedAt}`;

      const postResult = await postZulipAlert(message);
      zulipPostSent = postResult.sent;

      // Record the ATTEMPT regardless of outcome, so a dead notifier leaves a
      // trace any SQL query can find (OR-T1135, following a failure that went
      // undetected for ten days with nothing but a console.error to show for it).
      // last_notified_at is the cooldown key and is only set on success, same
      // as before this change: a failed attempt must not engage the cooldown,
      // or a dead notifier turns a one-time miss into permanent silence.
      const { error: stateWriteErr } = await client
        .from('drain_alert_state')
        .upsert({
          id:              1,
          last_attempt_at: checkedAt,
          last_error:      postResult.error ?? null,
          ...(postResult.sent ? { last_notified_at: checkedAt } : {}),
        });

      if (stateWriteErr) {
        console.error(
          '[or-quiltt-drain-alert] failed to record drain_alert_state attempt:',
          stateWriteErr.message,
        );
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
      retired_events: {
        retired_rows: retired,
        window_hours: RETIREMENT_WINDOW_HOURS,
        firing:       retiredFiring,
      },
      deferred_backlog: {
        deferred_unprocessed: deferredUnprocessed,
        oldest_age_hours:     oldestAgeHours,
        subaccounts:          deferredSubaccounts,
        count_threshold:      DEFERRED_BACKLOG_THRESHOLD,
        age_threshold_hours:  DEFERRED_BACKLOG_AGE_HOURS,
        firing:               deferredBacklogFiring,
      },
    },
  };

  return new Response(JSON.stringify(report), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
}, 'or-quiltt-drain-alert'));
