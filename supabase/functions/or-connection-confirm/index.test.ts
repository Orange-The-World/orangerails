/**
 * Deno tests for or-connection-confirm.
 *
 * Run with:
 *   deno test supabase/functions/or-connection-confirm/index.test.ts
 *
 * The HTTP handler binds Deno.serve which makes booting it inside a
 * test process awkward; we test the exported helpers in
 * _shared/connection-state.ts that the handler delegates to. Same
 * pattern as or-webhook-dispatch/index.test.ts. Integration coverage
 * of the HTTP surface comes from curl probes after deploy.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  confirmConnection,
  fetchScopedConnection,
  isValidUuid,
} from '../_shared/connection-state.ts';

interface MutationCall {
  kind: 'update' | 'delete';
  patch: Record<string, unknown> | null;
  filters: Array<{ col: string; val: unknown }>;
}

interface MockOpts {
  selectRow?: Record<string, unknown> | null;
  mutations: MutationCall[];
}

// Minimal Supabase-builder-shaped stub. Real PostgrestFilterBuilder is
// a thenable that resolves to { data, error } when awaited; .select()
// .eq() .update() .delete() etc. return the builder itself. We mimic
// that with a chain object that carries pending mutation state, records
// it the first time it is awaited, and resolves to a fixed shape.
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
          opts.mutations.push({
            kind: state.kind,
            patch: state.patch,
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
        update(patch: Record<string, unknown>) {
          state.kind = 'update';
          state.patch = patch;
          return chain;
        },
        delete() {
          state.kind = 'delete';
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: opts.selectRow ?? null, error: null });
        },
        // Make the chain itself awaitable for the mutation case
        // (.update().eq().eq() with no terminal call).
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

Deno.test('isValidUuid accepts canonical lowercase uuid', () => {
  assertEquals(isValidUuid('11111111-2222-3333-4444-555555555555'), true);
});

Deno.test('isValidUuid rejects non-uuid strings and bad types', () => {
  assertEquals(isValidUuid(''), false);
  assertEquals(isValidUuid('not-a-uuid'), false);
  assertEquals(isValidUuid(123), false);
  assertEquals(isValidUuid(undefined), false);
});

Deno.test('fetchScopedConnection returns row when scoped match found', async () => {
  const row = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'pending',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  };
  const client = makeMockClient({ selectRow: row, mutations: [] });
  const got = await fetchScopedConnection(client, row.id, row.subaccount_id);
  assertEquals(got, row);
});

Deno.test('fetchScopedConnection returns null when wrong owner or missing', async () => {
  const client = makeMockClient({ selectRow: null, mutations: [] });
  const got = await fetchScopedConnection(
    client,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  );
  assertEquals(got, null);
});

Deno.test('confirmConnection pending → active issues a guarded update', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await confirmConnection(client, {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'pending',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  assertEquals(result, 'active');
  assertEquals(mutations.length, 1);
  assertEquals(mutations[0].kind, 'update');
  assertEquals(mutations[0].patch?.status, 'active');
  // Belt-and-braces: must filter on status='pending' so a race with a
  // concurrent state change can't accidentally promote a non-pending row.
  assertEquals(
    mutations[0].filters.some(f => f.col === 'status' && f.val === 'pending'),
    true,
  );
});

Deno.test('confirmConnection on already-active is a no-op (idempotent)', async () => {
  const mutations: MutationCall[] = [];
  const client = makeMockClient({ mutations });
  const result = await confirmConnection(client, {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'active',
    subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  assertEquals(result, 'noop');
  assertEquals(mutations.length, 0);
});

Deno.test('confirmConnection refuses to promote from error/disconnected', async () => {
  for (const status of ['error', 'disconnected']) {
    const mutations: MutationCall[] = [];
    const client = makeMockClient({ mutations });
    const result = await confirmConnection(client, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status,
      subaccount_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    assertEquals(result, 'invalid_state');
    assertEquals(mutations.length, 0);
  }
});
