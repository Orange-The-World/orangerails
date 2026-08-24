/**
 * or-queue-health: one signal, every queue, coverage held in code.
 *
 * Checks the age of the oldest undrained row in each queue declared in
 * queues.ts and posts to chat when one is past its threshold. See queues.ts
 * for why this exists, why the signal is age, and what it cannot see.
 *
 * Auth: X-Internal-Worker-Token, constant-time compared to
 * OR_INTERNAL_WORKER_TOKEN. Same shape as or-quiltt-drain-alert, because
 * pg_cron reaches an edge function over HTTP with no user JWT to present.
 *
 * A query that fails counts as firing. A probe that could not run must never
 * report green: that is how a monitor becomes a source of false comfort, which
 * is worse than having no monitor at all because somebody trusts it.
 *
 * Always returns HTTP 200 with a JSON report, so a cron run is marked failed
 * only when the invocation itself failed.
 *
 * Env vars:
 *   OR_INTERNAL_WORKER_TOKEN                 caller auth (required)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  standard
 *   ZULIP_BOT_EMAIL, ZULIP_API_KEY, ZULIP_API_URL  chat posting
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  classify,
  type QueueDefinition,
  QUEUES,
  unmonitoredQueues,
  watchedQueues,
} from './queues.ts';

const SUPPRESSION_COOLDOWN_MINUTES = 60;
const ZULIP_TOPIC = 'queue staleness (DL-1568)';

interface QueueReport {
  table: string;
  oldest_undrained_at: string | null;
  age_hours: number | null;
  threshold_hours: number | null;
  /**
   * Three states, never a boolean. 'unknown' means the probe learned nothing
   * and must never be rendered as healthy (ruled on #378, 2026-08-01).
   */
  state: 'ok' | 'stalled' | 'unknown';
  /** Present for 'unknown'. Says what we could not find out, and why. */
  why?: string;
  error?: string;
}

interface HealthReport {
  checked_at: string;
  alert_firing: boolean;
  /** true = posted this run; false = suppressed or env missing; null = not firing */
  zulip_post_sent: boolean | null;
  queues: QueueReport[];
  delegated: { table: string; owner: string }[];
  /**
   * Queues nobody watches, and what it would take to watch them.
   *
   * In the report ON PURPOSE, and never omitted just because the watched
   * queues are healthy. A report that lists only what it checked is
   * indistinguishable from a report where everything is covered, and this
   * probe's entire argument is that the dangerous queue is the one nobody
   * was thinking about. A green run must still say out loud what it is
   * not looking at.
   */
  unmonitored: { table: string; needs: string }[];
}

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

/**
 * Oldest still-queued row for one queue.
 *
 * "Still queued" means the drain column is NULL and every terminal column is
 * NULL. Ordering ascending and taking one row means we read one row rather
 * than counting the whole table.
 *
 * ON INDEXES, because an earlier version of this comment claimed one covered
 * this and that was FALSE. `idx_webhook_delivery_pending` is partial on
 * `(succeeded_at IS NULL AND attempts < 5)`. This query deliberately omits the
 * attempts clause, because a row that exhausted its retries is exactly the row
 * we must still see, so Postgres cannot use that index: a partial index is only
 * usable when the query predicate implies the index predicate. The migration in
 * this change adds an index matching THIS predicate. Check both together if you
 * ever change the filter here.
 */
async function oldestUndrained(
  // deno-lint-ignore no-explicit-any
  client: any,
  q: QueueDefinition,
): Promise<{ at: string | null; error?: string }> {
  let query = client
    .from(q.table)
    .select(q.enqueuedAt)
    .is(q.drainedAt, null);

  for (const col of q.alsoTerminal) query = query.is(col, null);

  const { data, error } = await query
    .order(q.enqueuedAt, { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) return { at: null, error: error.message };
  return { at: data?.[q.enqueuedAt] ?? null };
}

async function postToZulip(message: string): Promise<boolean> {
  const botEmail = Deno.env.get('ZULIP_BOT_EMAIL');
  const apiKey = Deno.env.get('ZULIP_API_KEY');
  const apiUrl = Deno.env.get('ZULIP_API_URL');

  if (!botEmail || !apiKey || !apiUrl) {
    console.error('[or-queue-health] Zulip env vars missing; alert not posted to chat');
    return false;
  }

  const params = new URLSearchParams({
    type: 'stream',
    to: 'Delivery',
    topic: ZULIP_TOPIC,
    content: message,
  });

  try {
    const res = await fetch(`${apiUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${botEmail}:${apiKey}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[or-queue-health] Zulip post failed (${res.status}): ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[or-queue-health] Zulip post threw:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
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
  const queues: QueueReport[] = [];

  for (const q of watchedQueues()) {
    const { at, error } = await oldestUndrained(client, q);
    const threshold = q.coverage.kind === 'watched' ? q.coverage.stallHours : null;
    const verdict = classify(q, at, now, error ?? null);

    if (verdict.state === 'unknown') {
      // Loud, because this is the state a monitor must never hide. A probe that
      // cannot see is not a probe that found nothing.
      console.error(`[or-queue-health] UNKNOWN ${q.table}: ${verdict.why}`);
    } else if (verdict.state === 'stalled') {
      console.error(
        `[or-queue-health] ALERT ${q.table}: oldest undrained row is ` +
        `${verdict.ageHours.toFixed(1)}h old, threshold ${threshold}h`,
      );
    }

    const age = verdict.state === 'unknown' ? null : verdict.ageHours;
    queues.push({
      table: q.table,
      oldest_undrained_at: at,
      age_hours: age === null ? null : Number(age.toFixed(2)),
      threshold_hours: threshold,
      state: verdict.state,
      ...(verdict.state === 'unknown' ? { why: verdict.why } : {}),
      ...(error ? { error } : {}),
    });
  }

  // Anything that is not a clean 'ok' is worth telling someone about.
  const firingQueues = queues.filter((q) => q.state !== 'ok');
  const alertFiring = firingQueues.length > 0;
  let zulipPostSent: boolean | null = null;

  if (alertFiring) {
    // PER-QUEUE cooldown, not one global row. Ruled on 2026-08-10 reviewing
    // PR 648: a single suppression row means the first queue to stall silences
    // every other queue for the whole cooldown, so a second, unrelated outage
    // starting inside that hour is never announced at all.
    const tables = firingQueues.map((q) => q.table);
    const { data: stateRows, error: stateError } = await client
      .from('queue_health_alert_state')
      .select('queue, last_notified_at')
      .in('queue', tables);

    if (stateError) {
      // Fail towards posting. A missing cooldown read must not silence an
      // alert; a duplicate chat post is much cheaper than a missed outage.
      console.error(
        `[or-queue-health] cooldown read failed, posting anyway: ${stateError.message}`,
      );
    }

    const lastByQueue = new Map<string, string | null>(
      (stateRows ?? []).map((r) => [r.queue as string, r.last_notified_at as string | null]),
    );
    const cooldownMs = SUPPRESSION_COOLDOWN_MINUTES * 60 * 1000;
    const dueQueues = firingQueues.filter((q) => {
      const last = lastByQueue.get(q.table) ?? null;
      if (last === null) return true;
      return now.getTime() - new Date(last).getTime() >= cooldownMs;
    });

    if (dueQueues.length === 0) {
      console.log(
        `[or-queue-health] ${firingQueues.length} queue(s) firing, all inside ` +
        `the ${SUPPRESSION_COOLDOWN_MINUTES} min per-queue cooldown`,
      );
      zulipPostSent = false;
    } else {
      const lines = dueQueues.map((q) =>
        q.state === 'unknown'
          ? `:warning: **${q.table}**: probe could not check this queue: ${q.why ?? q.error}`
          : `:x: **${q.table}**: oldest undrained row is **${q.age_hours}h** old ` +
            `(threshold ${q.threshold_hours}h, queued at ${q.oldest_undrained_at})`
      );

      const message = [
        ':rotating_light: **Queue staleness alert**',
        '',
        ...lines,
        '',
        'A queue with an old undrained row means its drain is not running, or ' +
        'is running and failing. Check whether the job exists at all before ' +
        'checking whether it succeeded: an absent `cron.job` entry is how ' +
        'DL-1562 went unnoticed for ten weeks.',
        '',
        'A `could not check` line is NOT a clean bill of health. It means this ' +
        'probe learned nothing about that queue on this run.',
        '',
        `Coverage map and known blind spots: \`supabase/functions/or-queue-health/queues.ts\`. ` +
        `Reposts suppressed per queue for ${SUPPRESSION_COOLDOWN_MINUTES} min.`,
      ].join('\n');

      zulipPostSent = await postToZulip(message);
      if (zulipPostSent) {
        // Stamp only the queues actually named in this post. Stamping a queue
        // we suppressed would extend its silence without ever announcing it.
        const stampedAt = now.toISOString();
        const { error: upsertError } = await client
          .from('queue_health_alert_state')
          .upsert(
            dueQueues.map((q) => ({ queue: q.table, last_notified_at: stampedAt })),
            { onConflict: 'queue' },
          );
        if (upsertError) {
          console.error(
            `[or-queue-health] posted but could not stamp cooldown: ${upsertError.message}`,
          );
        }
      }
    }
  }

  const report: HealthReport = {
    checked_at: now.toISOString(),
    alert_firing: alertFiring,
    zulip_post_sent: zulipPostSent,
    queues,
    delegated: QUEUES
      .filter((q) => q.coverage.kind === 'delegated')
      .map((q) => ({
        table: q.table,
        owner: q.coverage.kind === 'delegated' ? q.coverage.owner : '',
      })),
    unmonitored: unmonitoredQueues()
      .map((q) => ({
        table: q.table,
        needs: q.coverage.kind === 'unmonitorable' ? q.coverage.needs : '',
      })),
  };

  return jsonResponse(report, 200);
}, 'or-queue-health'));
