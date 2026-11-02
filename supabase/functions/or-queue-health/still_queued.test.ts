/**
 * Tests for the still-queued filter and the webhook_delivery retry ceiling.
 *
 * Run: deno test --no-check --allow-read supabase/functions/or-queue-health/still_queued.test.ts
 *
 * The filter runs against a recording stub instead of a database, so these go
 * red when a filter is dropped: removing the `.lt` call from stillQueued fails
 * the ceiling test, and adding one to a queue with no ceiling fails the other.
 */

import { QUEUES, stillQueued } from './queues.ts';

type Call = [string, string, unknown];

interface Recorder {
  is(column: string, value: unknown): Recorder;
  lt(column: string, value: unknown): Recorder;
}

function recorder(): { builder: Recorder; calls: Call[] } {
  const calls: Call[] = [];
  const builder: Recorder = {
    is(column, value) {
      calls.push(['is', column, value]);
      return builder;
    },
    lt(column, value) {
      calls.push(['lt', column, value]);
      return builder;
    },
  };
  return { builder, calls };
}

function queue(table: string) {
  const q = QUEUES.find((x) => x.table === table);
  if (!q) throw new Error(`${table} is not declared in QUEUES`);
  return q;
}

function expectJson(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

Deno.test('webhook_delivery gives up at 5 attempts, counted on attempts', () => {
  expectJson(queue('webhook_delivery').giveUpAt, { column: 'attempts', ceiling: 5 });
});

Deno.test('stillQueued leaves out given-up rows with a numeric ceiling', () => {
  const { builder, calls } = recorder();
  stillQueued(queue('webhook_delivery'), builder);
  expectJson(calls, [['is', 'succeeded_at', null], ['lt', 'attempts', 5]]);
});

Deno.test('stillQueued adds no ceiling to a queue that declares none', () => {
  const { builder, calls } = recorder();
  stillQueued(queue('quiltt_webhook_inbox'), builder);
  expectJson(calls, [['is', 'processed_at', null], ['is', 'retirement_reason', null]]);
});

Deno.test('webhook_delivery blind spots name given-up rows, not an endless alert', () => {
  const text = queue('webhook_delivery').blindSpots.join(' ').toLowerCase();
  if (text.includes('alert forever')) throw new Error('stale blind spot is still there');
  if (!text.includes('given up')) throw new Error('blind spots must mention given-up rows');
});
