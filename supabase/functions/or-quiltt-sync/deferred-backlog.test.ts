import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  measureOpkDeferredBacklog,
  findBacklogBreaches,
  checkOpkDeferredBacklogAndAlert,
  type DeferredBacklogClient,
} from './deferred-backlog.ts';

/**
 * A fake supabase client scoped to what this module actually calls:
 * from(table).select().not().order().range(). No update or delete method
 * exists on it at all, so a code path that tried to call one would throw
 * "is not a function" rather than silently succeeding -- that absence is
 * itself part of the no-destructive-retention proof below.
 */
function makeFakeClient(rows: Array<{ subaccount_id: string; opk_deferred_at: string }>) {
  const calls: string[] = [];
  const client: DeferredBacklogClient = {
    from(table: string) {
      calls.push(table);
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        not() { return chain; },
        order() { return chain; },
        range(from: number, to: number) {
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

Deno.test('measureOpkDeferredBacklog: groups by subaccount and returns nonzero counts and ages', async () => {
  const now = new Date('2026-09-05T00:00:00.000Z');
  const { client } = makeFakeClient([
    { subaccount_id: 'sub-a', opk_deferred_at: '2026-08-21T00:00:00.000Z' }, // 15d old
    { subaccount_id: 'sub-a', opk_deferred_at: '2026-08-25T00:00:00.000Z' }, // 11d old, not the oldest
    { subaccount_id: 'sub-b', opk_deferred_at: '2026-09-04T00:00:00.000Z' }, // 1d old
  ]);

  const entries = await measureOpkDeferredBacklog(client, now);

  assertEquals(entries.length, 2, 'must return one entry per distinct subaccount, not per row');
  const subA = entries.find((e) => e.subaccount_id === 'sub-a');
  assert(subA, 'sub-a must be present');
  assertEquals(subA?.deferred_count, 2);
  assertEquals(subA?.oldest_deferred_at, '2026-08-21T00:00:00.000Z', 'must keep the OLDEST timestamp, not the last seen');
  assertEquals(subA?.age_days, 15, 'age must be computed from the oldest row, in days');

  const subB = entries.find((e) => e.subaccount_id === 'sub-b');
  assertEquals(subB?.deferred_count, 1);
  assertEquals(subB?.age_days, 1);
});

Deno.test('measureOpkDeferredBacklog: pages past a fixture larger than one page', async () => {
  // Forces two full pages: proves the offset actually advances instead of
  // trusting a single capped read, the same failure mode called out in
  // vault-persist.ts for this exact shape of bug.
  const rowCount = 1000 + 7; // MEASURE_PAGE_SIZE (1000) + a short second page
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    subaccount_id: `sub-${i}`,
    opk_deferred_at: '2026-08-01T00:00:00.000Z',
  }));
  const { client } = makeFakeClient(rows);

  const entries = await measureOpkDeferredBacklog(client, new Date('2026-09-05T00:00:00.000Z'));

  assertEquals(entries.length, rowCount, 'every distinct subaccount across both pages must be counted');
});

Deno.test('findBacklogBreaches: fires on age alone, on count alone, and on neither below both', () => {
  const threshold = { maxAgeDays: 14, maxCount: 25 };

  const oldButSmall = { subaccount_id: 's1', deferred_count: 2, oldest_deferred_at: 'x', age_days: 20 };
  const bigButFresh = { subaccount_id: 's2', deferred_count: 30, oldest_deferred_at: 'x', age_days: 1 };
  const healthy = { subaccount_id: 's3', deferred_count: 3, oldest_deferred_at: 'x', age_days: 2 };

  const breaches = findBacklogBreaches([oldButSmall, bigButFresh, healthy], threshold);

  assertEquals(breaches.map((b) => b.subaccount_id).sort(), ['s1', 's2']);
});

Deno.test('checkOpkDeferredBacklogAndAlert: the alert channel actually fires when the threshold is crossed', async () => {
  // This is the criterion the ticket calls out as the one that MUST be able
  // to fail: a monitor that runs quietly with no output is not a control.
  const now = new Date('2026-09-05T00:00:00.000Z');
  const { client } = makeFakeClient([
    { subaccount_id: 'sub-stuck', opk_deferred_at: '2026-08-01T00:00:00.000Z' }, // well past 14d
  ]);
  const reported: Error[] = [];

  const breaches = await checkOpkDeferredBacklogAndAlert(
    client,
    { maxAgeDays: 14, maxCount: 25 },
    (err) => { reported.push(err); },
    now,
  );

  assertEquals(breaches.length, 1, 'the breach must be returned');
  assertEquals(reported.length, 1, 'the alert channel must have fired exactly once');
  assert(reported[0].message.includes('sub-stuck'), 'the alert must name the subaccount');
  assert(reported[0].message.includes('opk-deferred-backlog'), 'the alert must be identifiable as this check, not a generic error');
});

Deno.test('checkOpkDeferredBacklogAndAlert: does NOT fire below both thresholds', async () => {
  const now = new Date('2026-09-05T00:00:00.000Z');
  const { client } = makeFakeClient([
    { subaccount_id: 'sub-healthy', opk_deferred_at: '2026-09-04T00:00:00.000Z' }, // 1 day, 1 row
  ]);
  const reported: Error[] = [];

  const breaches = await checkOpkDeferredBacklogAndAlert(
    client,
    { maxAgeDays: 14, maxCount: 25 },
    (err) => { reported.push(err); },
    now,
  );

  assertEquals(breaches.length, 0);
  assertEquals(reported.length, 0, 'a healthy backlog must not trigger the alert channel');
});

Deno.test('this module never issues a delete or update call', async () => {
  // The fake client above deliberately has no update()/delete() method at
  // all. If any code path in this file ever called one, this test would
  // throw "chain.update is not a function" rather than pass silently.
  const { client, calls } = makeFakeClient([
    { subaccount_id: 'sub-a', opk_deferred_at: '2026-08-01T00:00:00.000Z' },
  ]);

  await checkOpkDeferredBacklogAndAlert(
    client,
    { maxAgeDays: 14, maxCount: 25 },
    () => {},
    new Date('2026-09-05T00:00:00.000Z'),
  );

  assert(calls.every((t) => t === 'quiltt_webhook_inbox'), 'must only ever touch quiltt_webhook_inbox');
});
