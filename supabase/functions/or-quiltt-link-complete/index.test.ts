/**
 * Deno tests for or-quiltt-link-complete.
 *
 * Run with:
 *   deno test supabase/functions/or-quiltt-link-complete/index.test.ts
 *
 * Tests the exported helpers that implement the pending-then-activate
 * ordering introduced by DL-0740. A wallet-write failure must not leave
 * an active connection with zero selection rows; a success must promote
 * the pending row to active.
 *
 * The HTTP handler binds Deno.serve which makes booting it inside a test
 * process awkward; we test the exported helpers directly. Same pattern as
 * or-connection-confirm/index.test.ts. Integration coverage of the HTTP
 * surface comes from curl probes after deploy.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { activateConnection, rollbackPendingConnection } from './index.ts';

interface MutationCall {
  kind: 'update' | 'delete';
  patch?: Record<string, unknown>;
  filters: Array<{ col: string; val: unknown }>;
}

interface MockOpts {
  mutations: MutationCall[];
  /** Inject a DB error to exercise the failure path of each helper. */
  returnError?: { message: string } | null;
}

// Minimal Supabase-builder-shaped stub. Real PostgrestFilterBuilder is
// a thenable that resolves to { data, error } when awaited; .update()
// and .delete() return the builder itself. We mimic that with a chain
// object that records the first mutation when it is awaited, then
// resolves to a fixed shape. See or-connection-confirm/index.test.ts for
// the full rationale.
// deno-lint-ignore no-explicit-any
function makeMockClient(opts: MockOpts): any {
  return {
    from(_table: string) {
      const state = {
        kind: null as 'update' | 'delete' | null,
        patch: null as Record<string, unknown> | null,
        filters: [] as Array<{ col: string; val: unknown }>,
        recorded: false,
      };
      const recordIfMutation = () => {
        if (state.kind && !state.recorded) {
          const call: MutationCall = {
            kind: state.kind,
            filters: [...state.filters],
          };
          if (state.patch) call.patch = state.patch;
          opts.mutations.push(call);
          state.recorded = true;
        }
      };
      const chain: Record<string, unknown> = {
        update(patch: Record<string, unknown>) {
          state.kind = 'update';
          state.patch = patch;
          return chain;
        },
        delete() {
          state.kind = 'delete';
          return chain;
        },
        eq(col: string, val: unknown) {
          state.filters.push({ col, val });
          return chain;
        },
        // Make the chain itself awaitable (.update().eq().eq() with no
        // terminal call). Records the mutation on first await.
        // deno-lint-ignore no-explicit-any
        then(onResolve: (r: { data: null; error: { message: string } | null }) => unknown): any {
          recordIfMutation();
          return Promise.resolve({ data: null, error: opts.returnError ?? null }).then(onResolve);
        },
      };
      return chain;
    },
  };
}

const TEST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

Deno.test('DL-0740: rollbackPendingConnection deletes the pending row scoped by id and status guard', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  await rollbackPendingConnection(client, TEST_ID);

  assertEquals(mutations.length, 1);
  assertEquals(mutations[0].kind, 'delete');
  assertEquals(
    mutations[0].filters.some(f => f.col === 'id' && f.val === TEST_ID),
    true,
    'must filter by connection id so only the right row is removed',
  );
  assertEquals(
    mutations[0].filters.some(f => f.col === 'status' && f.val === 'pending'),
    true,
    'must guard on status=pending so it cannot delete an already-active row',
  );
});

// ---- Return-value tests (fail-closed, DL-0740) ----

Deno.test('DL-0740: activateConnection returns null on DB success', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await activateConnection(client, TEST_ID);
  assertEquals(result, null, 'must return null when no DB error');
});

Deno.test('DL-0740: activateConnection returns error string on DB failure', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations, returnError: { message: 'connection timeout' } });
  const result = await activateConnection(client, TEST_ID);
  assertEquals(typeof result, 'string', 'must return a string when DB errors');
  assertEquals(
    (result as string).includes('connection timeout'),
    true,
    'error string must include the DB error message',
  );
});

Deno.test('DL-0740: rollbackPendingConnection returns null on DB success', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await rollbackPendingConnection(client, TEST_ID);
  assertEquals(result, null, 'must return null when no DB error');
});

Deno.test('DL-0740: rollbackPendingConnection returns error string on DB failure', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations, returnError: { message: 'row locked' } });
  const result = await rollbackPendingConnection(client, TEST_ID);
  assertEquals(typeof result, 'string', 'must return a string when DB errors');
  assertEquals(
    (result as string).includes('row locked'),
    true,
    'error string must include the DB error message',
  );
});

// ---- Mutation-shape tests (original DL-0740 coverage) ----

Deno.test('DL-0740: activateConnection promotes the pending row to active with status guard', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  await activateConnection(client, TEST_ID);

  assertEquals(mutations.length, 1);
  assertEquals(mutations[0].kind, 'update');
  assertEquals(mutations[0].patch?.status, 'active', 'must set status to active');
  assertEquals(
    mutations[0].filters.some(f => f.col === 'id' && f.val === TEST_ID),
    true,
    'must filter by connection id',
  );
  assertEquals(
    mutations[0].filters.some(f => f.col === 'status' && f.val === 'pending'),
    true,
    'must guard on status=pending to prevent double-activate races',
  );
});
