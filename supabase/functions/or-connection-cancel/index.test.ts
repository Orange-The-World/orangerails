/**
 * Deno tests for or-connection-cancel.
 *
 * Run with:
 *   deno test supabase/functions/or-connection-cancel/index.test.ts
 *
 * Tests the exported helpers in _shared/connection-state.ts that the
 * handler delegates to. Integration coverage of the HTTP surface
 * comes from curl probes after deploy.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  cancelPendingConnection,
  fetchScopedConnection,
} from '../_shared/connection-state.ts';

interface MutationCall {
  kind: 'update' | 'delete';
  filters: Array<{ col: string; val: unknown }>;
}

interface MockOpts {
  selectRow?: Record<string, unknown> | null;
  mutations: MutationCall[];
}

// See or-connection-confirm/index.test.ts for the rationale on the
// thenable-builder shape; this mirrors it.
// deno-lint-ignore no-explicit-any
function makeMockClient(opts: MockOpts): any {
  return {
    from(_table: string) {
      const state = {
        kind: null as 'update' | 'delete' | null,
        filters: [] as Array<{ col: string; val: unknown }>,
        recorded: false,
      };
      const recordIfMutation = () => {
        if (state.kind && !state.recorded) {
          opts.mutations.push({
            kind: state.kind,
            filters: [...state.filters],
          });
          state.recorded = true;
        }
      };
      const chain: Record<string, unknown> = {
        select(_cols: string) { return chain; },
        eq(col: string, val: unknown) {
          state.filters.push({ col, val });
          return chain;
        },
        update(_patch: Record<string, unknown>) {
          state.kind = 'update';
          return chain;
        },
        delete() {
          state.kind = 'delete';
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: opts.selectRow ?? null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        then(onResolve: (r: { data: null; error: null }) => unknown): any {
          recordIfMutation();
          return Promise.resolve({ data: null, error: null }).then(onResolve);
        },
      };
      return chain;
    },
  };
}

Deno.test('fetchScopedConnection scopes by subaccount and returns row', async () => {
  const row = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'pending',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  };
  const client = makeMockClient({ selectRow: row, mutations: [] });
  const got = await fetchScopedConnection(client, row.id, row.subaccount_id);
  assertEquals(got, row);
});

Deno.test('fetchScopedConnection wrong tenant returns null (no existence leak)', async () => {
  const client = makeMockClient({ selectRow: null, mutations: [] });
  const got = await fetchScopedConnection(
    client,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
  );
  assertEquals(got, null);
});

Deno.test('cancelPendingConnection deletes pending row with status guard', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await cancelPendingConnection(client, {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'pending',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  assertEquals(result, 'deleted');
  assertEquals(mutations.length, 1);
  assertEquals(mutations[0].kind, 'delete');
  // Belt-and-braces: must filter on status='pending' to avoid blowing
  // away an active row that flipped state in a race.
  assertEquals(
    mutations[0].filters.some(f => f.col === 'status' && f.val === 'pending'),
    true,
  );
});

Deno.test('cancelPendingConnection refuses to delete an active row (409 path)', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await cancelPendingConnection(client, {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'active',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  assertEquals(result, 'already_active');
  assertEquals(mutations.length, 0);
});

Deno.test('cancelPendingConnection on error/disconnected is invalid_state', async () => {
  for (const status of ['error', 'disconnected']) {
    const mutations: MutationCall[] = [];
    const client = makeMockClient({ mutations });
    const result = await cancelPendingConnection(client, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status,
      subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    assertEquals(result, 'invalid_state');
    assertEquals(mutations.length, 0);
  }
});
