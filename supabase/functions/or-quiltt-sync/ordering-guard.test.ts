/**
 * OR-T2694: errored-event ordering guard, event to event.
 *
 * Run with: deno test supabase/functions/or-quiltt-sync/ordering-guard.test.ts
 *
 * The fake below is STATEFUL and models the connections trigger: every update
 * to a connections row moves updated_at to "now". Fixtures that set updated_at
 * by hand are how the first guard's tests passed while the guard was wrong.
 * The success event is applied with the real reconcileConnectionSuccess, so the
 * row timestamp moves exactly as it does in production.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { reconcileConnectionError, reconcileConnectionSuccess } from './index.ts';

type Row = Record<string, any>; // deno-lint-ignore no-explicit-any

function pick(row: Row, col: string): unknown {
  if (col.includes('->')) {
    const [head, ...rest] = col.split('->').map((s) => s.replace(/^>/, ''));
    let cur: any = row[head]; // deno-lint-ignore no-explicit-any
    for (const k of rest) cur = cur?.[k];
    return cur;
  }
  return row[col];
}

function fakeDb(tables: Record<string, Row[]>, opts: { inboxError?: string } = {}) {
  let writes = 0;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const preds: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let max = Infinity;
      const run = () => {
        if (table === 'quiltt_webhook_inbox' && opts.inboxError) {
          return { data: null, error: { message: opts.inboxError } };
        }
        const hit = rows.filter((r) => preds.every((p) => p(r))).slice(0, max);
        if (patch) {
          for (const r of hit) {
            Object.assign(r, patch);
            if (table === 'connections') r.updated_at = new Date().toISOString(); // the trigger
          }
          if (table === 'connections') writes++;
          return { data: null, error: null };
        }
        return { data: hit, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        update(p: Row) { patch = p; return chain; },
        eq(c: string, v: unknown) { preds.push((r) => pick(r, c) === v); return chain; },
        is(c: string, v: unknown) { preds.push((r) => (pick(r, c) ?? null) === v); return chain; },
        in(c: string, vs: unknown[]) { preds.push((r) => vs.includes(pick(r, c))); return chain; },
        not(c: string, _op: string, v: unknown) { preds.push((r) => (pick(r, c) ?? null) !== v); return chain; },
        like(c: string, pat: string) {
          const prefix = pat.replace(/%$/, '');
          preds.push((r) => String(pick(r, c) ?? '').startsWith(prefix));
          return chain;
        },
        gt(c: string, v: string) { preds.push((r) => String(pick(r, c)) > v); return chain; },
        order() { return chain; },
        limit(n: number) { max = n; return chain; },
        maybeSingle() { const o = run(); return Promise.resolve({ data: o.data?.[0] ?? null, error: o.error }); },
        single() { const o = run(); return Promise.resolve({ data: o.data?.[0] ?? null, error: o.error }); },
        // deno-lint-ignore no-explicit-any
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
      };
      return chain;
    },
  };
  return { client, connWrites: () => writes };
}

const T1 = '2026-09-01T00:00:01.000Z';
const T2 = '2026-09-01T00:00:02.000Z';
const T3 = '2026-09-01T00:00:03.000Z';

function conn(over: Row = {}): Row {
  return {
    id: 'conn-1', subaccount_id: 'sub-1', provider_type: 'quiltt',
    quiltt_connection_id: 'q1', status: 'error', encrypted_last_error: 'OLD:x',
    updated_at: '2026-08-01T00:00:00.000Z', ...over,
  };
}
function inbox(id: string, type: string, received_at: string, qid = 'q1', over: Row = {}): Row {
  return {
    event_id: id, event_type: type, subaccount_id: 'sub-1', platform_id: 'plat-1',
    payload: { record: { id: qid } }, received_at, processed_at: null, retirement_reason: null, ...over,
  };
}
const platforms = [{ id: 'plat-1', sink_format: 'bitbooks-v2' }];
const errEv = (id: string, received_at: string, qid = 'q1') => ({
  event_id: id, event_type: 'connection.synced.errored.repairable',
  payload: { record: { id: qid } }, platform_id: 'plat-1', subaccount_id: 'sub-1',
  attempts: 0, received_at,
});

Deno.test('OR-T2694: success processed just before a NEWER error in the same drain -> the error still lands', async () => {
  const c = conn({ status: 'error' });
  const s = inbox('S', 'connection.synced.successful.initial', T2);
  const db = fakeDb({ connections: [c], quiltt_webhook_inbox: [s, inbox('E2', 'connection.synced.errored.repairable', T3)], platforms });
  // drain order is received_at ASC: S first, then E2
  // deno-lint-ignore no-explicit-any
  assertEquals(await reconcileConnectionSuccess(db.client as any, 'q1', 'sub-1'), null);
  s.processed_at = '2026-09-01T00:00:10.000Z';
  assertEquals(c.status, 'active', 'precondition: the success recovered the row (and the trigger moved updated_at to now)');
  // deno-lint-ignore no-explicit-any
  assertEquals(await reconcileConnectionError(db.client as any, errEv('E2', T3), 'sub-1'), null);
  assertEquals(c.status, 'error', 'a real newer error must not be dropped because the row was touched by the earlier success');
});

Deno.test('OR-T2694 mirror: an OLD error retried after a NEWER success ends active', async () => {
  const c = conn({ status: 'error' });
  const s = inbox('S', 'connection.synced.successful.initial', T2);
  const db = fakeDb({ connections: [c], quiltt_webhook_inbox: [inbox('E1', 'connection.synced.errored.repairable', T1), s], platforms });
  // deno-lint-ignore no-explicit-any
  await reconcileConnectionSuccess(db.client as any, 'q1', 'sub-1');
  s.processed_at = '2026-09-01T00:00:10.000Z';
  assertEquals(c.status, 'active');
  // deno-lint-ignore no-explicit-any
  assertEquals(await reconcileConnectionError(db.client as any, errEv('E1', T1), 'sub-1'), null);
  assertEquals(c.status, 'active', 'a superseded error must not re-break a recovered connection');
});

Deno.test('OR-T2694: a newer success on a DIFFERENT Quiltt connection under the same subaccount does not suppress the error (OR-T2218)', async () => {
  const c = conn({ status: 'active', encrypted_last_error: null });
  const otherSuccess = inbox('S2', 'connection.synced.successful.initial', T2, 'q2', { processed_at: T3 });
  const db = fakeDb({ connections: [c], quiltt_webhook_inbox: [otherSuccess], platforms });
  // deno-lint-ignore no-explicit-any
  assertEquals(await reconcileConnectionError(db.client as any, errEv('E1', T1, 'q1'), 'sub-1'), null);
  assertEquals(c.status, 'error');
});

Deno.test('OR-T2694: a RETIRED newer success never reconciled anything, so it does not suppress the error', async () => {
  const c = conn({ status: 'active', encrypted_last_error: null });
  const retired = inbox('S', 'connection.synced.successful.initial', T2, 'q1', {
    processed_at: T3, retirement_reason: 'max-attempts-pre-dispatch',
  });
  const db = fakeDb({ connections: [c], quiltt_webhook_inbox: [retired], platforms });
  // deno-lint-ignore no-explicit-any
  await reconcileConnectionError(db.client as any, errEv('E1', T1), 'sub-1');
  assertEquals(c.status, 'error');
});

Deno.test('OR-T2694: a failed ordering lookup returns an error (retry) and writes nothing', async () => {
  const c = conn({ status: 'active', encrypted_last_error: null });
  const db = fakeDb({ connections: [c], quiltt_webhook_inbox: [], platforms }, { inboxError: 'timeout' });
  // deno-lint-ignore no-explicit-any
  const err = await reconcileConnectionError(db.client as any, errEv('E1', T1), 'sub-1');
  assertEquals(typeof err === 'string' && err.includes('newer-success lookup failed'), true);
  assertEquals(c.status, 'active');
  assertEquals(db.connWrites(), 0);
});
