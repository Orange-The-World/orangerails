/**
 * or-quiltt-drain-alert -- five-signal health check for or_quiltt_sync_drain
 *
 * Signals (DL-0640, signal D added by DL-1540, signal E added by OR-T2583):
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
 *   E. Starvation bound: the fetch batch (BATCH_SIZE = 20 in or-quiltt-sync)
 *      is fully occupied by rows that are unprocessed and not opk-deferred
 *      (processed_at IS NULL AND opk_deferred_at IS NULL), and the oldest of
 *      them is older than the proven 25 minute worst-case retirement bound
 *      from OR-T2581. That combination means the batch has been stuck longer
 *      than the whole cluster should ever take to age out: real starvation,
 *      not a normal burst.
 *
 *      Signal C does not catch this: it only fires after 2 hours on any
 *      single stale row, and it does not exclude opk-deferred rows, which
 *      are expected to sit unprocessed while a subaccount waits on its OPK.
 *      Signal E is scoped to the exact starvation shape OR-T2581 proved,
 *      with a much tighter age bound. Its snapshot contribution (below) is
 *      deliberately just starvation_firing and the row count, not the age
 *      in minutes, because the age changes every run even when nothing else
 *      does and would defeat content dedup.
 *
 * Auth: X-Internal-Worker-Token header, constant-time compared to OR_INTERNAL_WORKER_TOKEN.
 * Query errors surface as alert_firing = true (absence of evidence is not green).
 * Returns HTTP 200 always with a JSON health report.
 * When alert_firing, POSTs to Zulip #Delivery mentioning CTO Rails and SRE.
 * Repost suppression:
 *   - Hard floor: never post more than once per SUPPRESSION_COOLDOWN_MINUTES (60 min).
 *   - Content dedup: between the 60-min floor and RE_ALERT_CEILING_HOURS (6h), only
 *     post when the signal snapshot changes (different signals firing, or different
 *     counts). An unchanged snapshot is suppressed until the ceiling forces a repost.
 *   - Re-alert ceiling: after RE_ALERT_CEILING_HOURS since the last post, always post
 *     (even if unchanged) so a persistent stall does not go silently dark.
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

const FAILURE_WINDOW_MINUTES       = 30;
const SUCCESS_WINDOW_MINUTES       = 60;
const FAILURE_RATE_THRESHOLD       = 0.10; // 10%
const STALL_HOURS                  = 2;
const RETIREMENT_WINDOW_HOURS      = 24;
const STARVATION_UNPROCESSED_MIN   = 20; // BATCH_SIZE in or-quiltt-sync
const STARVATION_AGE_MINUTES       = 25; // proven worst-case retirement bound (OR-T2581)
const SUPPRESSION_COOLDOWN_MINUTES = 60;
/** Maximum time to suppress an unchanged firing signal before forcing a repost. */
const RE_ALERT_CEILING_HOURS       = 6;

interface DrainCronStats {
  failed_count:    number;
  total_count:     number;
  succeeded_count: number;
}

/**
 * Snapshot of the observable signal state at the time of a Zulip post.
 * Stored in drain_alert_state.last_signal_snapshot and compared on each run
 * to suppress reposts when nothing has changed (OR-T2708).
 * Serialized with JSON.stringify for equality; key order must stay stable.
 */
interface SignalSnapshot {
  failure_rate_firing:      boolean;
  failure_rate:              number | null;
  zero_completions_firing:  boolean;
  succeeded_count:           number | null;
  stall_firing:              boolean;
  stalled:                   number | null;
  retired_firing:            boolean;
  retired:                   number | null;
  starvation_firing:         boolean;
  unprocessed_non_deferred:  number | null;
  query_error:                string | null;
}

function buildSnapshot(
  failureRateFiring:      boolean,
  failureRate:            number | null,
  zeroCompletionsFiring:  boolean,
  succeededCount:         number | null,
  stallFiring:            boolean,
  stalled:                number | null,
  retiredFiring:          boolean,
  retired:                number | null,
  starvationFiring:       boolean,
  unprocessedNonDeferred: number | null,
  queryError:             string | undefined,
): SignalSnapshot {
  return {
    failure_rate_firing:      failureRateFiring,
    failure_rate:             failureRate,
    zero_completions_firing:  zeroCompletionsFiring,
    succeeded_count:          succeededCount,
    stall_firing:             stallFiring,
    stalled:                  stalled,
    retired_firing:           retiredFiring,
    retired:                  retired,
    starvation_firing:        starvationFiring,
    unprocessed_non_deferred: unprocessedNonDeferred,
    query_error:              queryError ?? null,
  };
}

/** True when two snapshots represent the same observable signal state. */
function snapshotsMatch(a: SignalSnapshot | null, b: SignalSnapshot): boolean {
  if (a === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
    starvation: {
      unprocessed_non_deferred:       number | null;
      retried_at_least_once:          number | null;
      oldest_unprocessed_age_minutes: number | null;
      unprocessed_threshold:          number;
      age_threshold_minutes:          number;
      firing:                         boolean;
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

  // Signal E: starvation bound -- the fetch batch is fully occupied by rows
  // that are unprocessed and not opk-deferred, and the oldest of them is
  // older than the proven worst-case retirement bound. Same columns
  // fetchPendingBatch (or-quiltt-sync) filters on: processed_at IS NULL AND
  // opk_deferred_at IS NULL.
  const { count: unprocessedNonDeferredCount, error: starvationCountErr } = await client
    .from('quiltt_webhook_inbox')
    .select('*', { count: 'exact', head: true })
    .is('processed_at', null)
    .is('opk_deferred_at', null);

  if (starvationCountErr) {
    console.error(
      '[or-quiltt-drain-alert] signal E (starvation, count) query failed:',
      starvationCountErr.message,
    );
  }

  const { count: retriedAtLeastOnceCount, error: starvationRetriedErr } = await client
    .from('quiltt_webhook_inbox')
    .select('*', { count: 'exact', head: true })
    .is('processed_at', null)
    .is('opk_deferred_at', null)
    .gt('attempts', 0);

  if (starvationRetriedErr) {
    console.error(
      '[or-quiltt-drain-alert] signal E (starvation, retried) query failed:',
      starvationRetriedErr.message,
    );
  }

  const { data: oldestUnprocessedRows, error: starvationOldestErr } = await client
    .from('quiltt_webhook_inbox')
    .select('received_at')
    .is('processed_at', null)
    .is('opk_deferred_at', null)
    .order('received_at', { ascending: true })
    .limit(1);

  if (starvationOldestErr) {
    console.error(
      '[or-quiltt-drain-alert] signal E (starvation, oldest) query failed:',
      starvationOldestErr.message,
    );
  }

  const unprocessedNonDeferred: number | null = unprocessedNonDeferredCount ?? null;
  const retriedAtLeastOnce:     number | null = retriedAtLeastOnceCount ?? null;
  const oldestUnprocessedAt:    string | null = oldestUnprocessedRows?.[0]?.received_at ?? null;
  const oldestUnprocessedAgeMinutes: number | null = oldestUnprocessedAt !== null
    ? (Date.now() - new Date(oldestUnprocessedAt).getTime()) / 60000
    : null;

  const starvationFiring =
    unprocessedNonDeferred !== null &&
    oldestUnprocessedAgeMinutes !== null &&
    unprocessedNonDeferred >= STARVATION_UNPROCESSED_MIN &&
    oldestUnprocessedAgeMinutes > STARVATION_AGE_MINUTES;

  // Surface query errors: a probe that cannot run must not exit green.
  const queryErrors: string[] = [];
  if (statsErr) queryErrors.push(`signals A+B (cron stats): ${statsErr.message}`);
  if (stallErr) queryErrors.push(`signal C (queue stall): ${stallErr.message}`);
  if (retiredErr) queryErrors.push(`signal D (retired events): ${retiredErr.message}`);
  if (starvationCountErr) queryErrors.push(`signal E (starvation, count): ${starvationCountErr.message}`);
  if (starvationRetriedErr) queryErrors.push(`signal E (starvation, retried): ${starvationRetriedErr.message}`);
  if (starvationOldestErr) queryErrors.push(`signal E (starvation, oldest): ${starvationOldestErr.message}`);
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
  if (starvationFiring) {
    console.error(
      `[or-quiltt-drain-alert] ALERT signal E (starvation): ` +
      `${unprocessedNonDeferred} unprocessed non-deferred row(s), oldest ` +
      `${(oldestUnprocessedAgeMinutes ?? 0).toFixed(1)} min old ` +
      `(threshold: >=${STARVATION_UNPROCESSED_MIN} rows AND >${STARVATION_AGE_MINUTES} min)`,
    );
  }

  const alertFiring = failureRateFiring || zeroCompletionsFiring || stallFiring ||
    retiredFiring || starvationFiring || queryError !== undefined;

  // zulip_post_sent: null when not firing, true/false when firing based on outcome.
  let zulipPostSent: boolean | null = null;

  if (alertFiring) {
    // Read suppression state: time of last post + last-posted signal snapshot.
    const { data: stateRow } = await client
      .from('drain_alert_state')
      .select('last_notified_at, last_signal_snapshot')
      .eq('id', 1)
      .maybeSingle();

    const lastNotifiedAt: string | null = stateRow?.last_notified_at ?? null;
    const lastSnapshot: SignalSnapshot | null =
      (stateRow?.last_signal_snapshot as SignalSnapshot | null) ?? null;

    const cooldownMs       = SUPPRESSION_COOLDOWN_MINUTES * 60 * 1000;
    const realertCeilingMs = RE_ALERT_CEILING_HOURS * 60 * 60 * 1000;
    const msSinceLastPost  =
      lastNotifiedAt !== null
        ? Date.now() - new Date(lastNotifiedAt).getTime()
        : Infinity;

    const withinCooldown       = msSinceLastPost < cooldownMs;
    const withinRealertCeiling = msSinceLastPost < realertCeilingMs;

    const currentSnapshot = buildSnapshot(
      failureRateFiring, failureRate,
      zeroCompletionsFiring, succeededCount,
      stallFiring, stalled,
      retiredFiring, retired,
      starvationFiring, unprocessedNonDeferred,
      queryError,
    );
    const snapshotChanged = !snapshotsMatch(lastSnapshot, currentSnapshot);

    if (withinCooldown) {
      // Hard rate-limit floor: never post more often than once per SUPPRESSION_COOLDOWN_MINUTES.
      // Applies regardless of snapshot changes to prevent burst-posting on rapid oscillations.
      console.log(
        `[or-quiltt-drain-alert] alert firing but suppressed ` +
        `(last post: ${lastNotifiedAt}, cooldown: ${SUPPRESSION_COOLDOWN_MINUTES} min)`,
      );
      zulipPostSent = false;
    } else if (withinRealertCeiling && !snapshotChanged) {
      // Past the 60-min floor but within the 6-hour re-alert ceiling, and the
      // signal content is unchanged since the last post. Suppress: we already
      // told them about this exact state and nothing new has happened.
      console.log(
        `[or-quiltt-drain-alert] alert firing but suppressed ` +
        `(snapshot unchanged, re-alert ceiling not reached; last post: ${lastNotifiedAt})`,
      );
      zulipPostSent = false;
    } else {
      // Post because either:
      //   a) snapshot changed (new signals firing, or different counts)
      //   b) 6-hour re-alert ceiling hit (persistent stall must not go silently dark)
      const reason = snapshotChanged
        ? 'snapshot changed'
        : `re-alert ceiling (${RE_ALERT_CEILING_HOURS}h) hit`;
      console.log(`[or-quiltt-drain-alert] posting alert (${reason})`);

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
      if (starvationFiring) {
        parts.push(
          `:x: **Signal E (starvation):** ${unprocessedNonDeferred} unprocessed non-deferred ` +
          `row(s), oldest ${(oldestUnprocessedAgeMinutes ?? 0).toFixed(1)} min old. The fetch batch ` +
          `has been fully occupied longer than the proven ${STARVATION_AGE_MINUTES} min worst-case ` +
          `retirement bound (OR-T2581): this is starvation, not a normal burst.`,
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
      // last_notified_at and last_signal_snapshot are only set on success:
      // a failed attempt must not engage the cooldown or update the snapshot,
      // or a dead notifier silences itself permanently.
      const { error: stateWriteErr } = await client
        .from('drain_alert_state')
        .upsert({
          id:              1,
          last_attempt_at: checkedAt,
          last_error:      postResult.error ?? null,
          ...(postResult.sent ? {
            last_notified_at:     checkedAt,
            last_signal_snapshot: currentSnapshot,
          } : {}),
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
      starvation: {
        unprocessed_non_deferred:       unprocessedNonDeferred,
        retried_at_least_once:          retriedAtLeastOnce,
        oldest_unprocessed_age_minutes: oldestUnprocessedAgeMinutes,
        unprocessed_threshold:          STARVATION_UNPROCESSED_MIN,
        age_threshold_minutes:          STARVATION_AGE_MINUTES,
        firing:                         starvationFiring,
      },
    },
  };

  return new Response(JSON.stringify(report), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
}, 'or-quiltt-drain-alert'));
