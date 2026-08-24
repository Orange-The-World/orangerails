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
  ageHours,
  isStalled,
  type QueueDefinition,
  QUEUES,
  watchedQueues,
} from './queues.ts';

const SUPPRESSION_COOLDOWN_MINUTES = 60;
const ZULIP_TOPIC = 'queue staleness (DL-1568)';

interface QueueReport {
  table: string;
  oldest_undrained_at: string | null;
  age_hours: number | null;
  threshold_hours: number | null;
  firing: boolean;
  error?: string;
}

interface HealthReport {
  checked_at: string;
  alert_firing: boolean;
  /** true = posted this run; false = suppressed or env missing; null = not firing */
  zulip_post_sent: boolean | null;
  queues: QueueReport[];
  delegated: { table: string; owner: string }[];
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
 * NULL. Ordering ascending and taking one row lets the index do the work
 * rather than counting the whole table.
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
    const age = ageHours(at, now);

    // A failed query fires. Absence of evidence is not green.
    const firing = error !== undefined || isStalled(q, at, now);

    if (error) {
      console.error(`[or-queue-health] ${q.table}: query failed: ${error}`);
    } else if (firing) {
      console.error(
        `[or-queue-health] ALERT ${q.table}: oldest undrained row is ` +
        `${(age ?? 0).toFixed(1)}h old, threshold ${threshold}h`,
      );
    }

    queues.push({
      table: q.table,
      oldest_undrained_at: at,
      age_hours: age === null ? null : Number(age.toFixed(2)),
      threshold_hours: threshold,
      firing,
      ...(error ? { error } : {}),
    });
  }

  const alertFiring = queues.some((q) => q.firing);
  let zulipPostSent: boolean | null = null;

  if (alertFiring) {
    const { data: stateRow } = await client
      .from('queue_health_alert_state')
      .select('last_notified_at')
      .eq('id', 1)
      .maybeSingle();

    const lastNotifiedAt: string | null = stateRow?.last_notified_at ?? null;
    const withinCooldown = lastNotifiedAt !== null &&
      now.getTime() - new Date(lastNotifiedAt).getTime() <
        SUPPRESSION_COOLDOWN_MINUTES * 60 * 1000;

    if (withinCooldown) {
      console.log(
        `[or-queue-health] firing but suppressed (last post: ${lastNotifiedAt}, ` +
        `cooldown: ${SUPPRESSION_COOLDOWN_MINUTES} min)`,
      );
      zulipPostSent = false;
    } else {
      const lines = queues.filter((q) => q.firing).map((q) =>
        q.error
          ? `:warning: **${q.table}**: probe could not run: ${q.error}`
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
        `Coverage map and known blind spots: \`supabase/functions/or-queue-health/queues.ts\`. ` +
        `Reposts suppressed for ${SUPPRESSION_COOLDOWN_MINUTES} min.`,
      ].join('\n');

      zulipPostSent = await postToZulip(message);
      if (zulipPostSent) {
        await client
          .from('queue_health_alert_state')
          .update({ last_notified_at: now.toISOString() })
          .eq('id', 1);
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
  };

  return jsonResponse(report, 200);
}, 'or-queue-health'));
