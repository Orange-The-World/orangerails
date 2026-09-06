/**
 * Deno tests for or-connection-delete: stealth fallback path.
 *
 * Run with:
 *   deno test supabase/functions/or-connection-delete/index.test.ts
 *
 * Tests tryDeleteStealthConnection, which handles the case where a
 * connection_id is absent from `connections` but present in (or absent
 * from) `stealth_connections`. Three cases from DL-1033:
 *   1. Stealth id deleted successfully (count=1).
 *   2. Foreign subaccount: id exists in stealth_connections but belongs to
 *      a different scope, delete matches zero rows => 404.
 *   3. Unknown id: not in either table, delete matches zero rows => 404.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tryDeleteStealthConnection, importAesKey } from './index.ts';

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

Deno.test('importAesKey grants decrypt only, not encrypt (OR-T0723)', async () => {
  const key = await importAesKey(TEST_KEY_B64);
  assertEquals(key.extractable, false);
  assertEquals([...key.usages], ['decrypt']);
});

const SUBACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PLATFORM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const APP_USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

interface FilterCall {
  col: string;
  val: unknown;
}

interface DeleteRecord {
  table: string;
  filters: FilterCall[];
}

interface MockOpts {
  subaccountRow?: { platform_id: string; external_user_id: string } | null;
  subaccountError?: unknown;
  stealthDeleteCount?: number;
  stealthDeleteError?: unknown;
  deleteRecords: DeleteRecord[];
}

// deno-lint-ignore no-explicit-any
function makeMockClient(opts: MockOpts): any {
  return {
    from(table: string) {
      const filters: FilterCall[] = [];
      const chain: Record<string, unknown> = {
        select(_cols: string) { return chain; },
        delete(_deleteOpts?: unknown) { return chain; },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return chain;
        },
        maybeSingle() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: opts.subaccountRow ?? null,
              error: opts.subaccountError ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        then(onResolve: (r: unknown) => unknown): any {
          if (table === 'stealth_connections') {
            opts.deleteRecords.push({ table, filters: [...filters] });
            return Promise.resolve({
              data: null,
              error: opts.stealthDeleteError ?? null,
              count: opts.stealthDeleteCount ?? 0,
            }).then(onResolve);
          }
          return Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
        },
      };
      return chain;
    },
  };
}

Deno.test('stealth id in same subaccount is deleted (count=1)', async () => {
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 1,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, CONNECTION_ID, SUBACCOUNT_ID);

  assertEquals(result, { deleted: true });
  // Delete was attempted exactly once
  assertEquals(deleteRecords.length, 1);
  // All three ownership filters applied: id, platform_id, app_user_id
  const { filters } = deleteRecords[0];
  assertEquals(filters.some(f => f.col === 'id' && f.val === CONNECTION_ID), true);
  assertEquals(filters.some(f => f.col === 'platform_id' && f.val === PLATFORM_ID), true);
  assertEquals(filters.some(f => f.col === 'app_user_id' && f.val === APP_USER_ID), true);
});

Deno.test('foreign subaccount: count=0 returns notFound, no widening', async () => {
  // The id may exist in stealth_connections but belong to a different
  // (platform_id, app_user_id) pair. The delete should match zero rows
  // and return notFound without touching any other row.
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 0,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, CONNECTION_ID, SUBACCOUNT_ID);

  assertEquals(result, { notFound: true });
  // Ownership filters were still applied (scope was not widened)
  assertEquals(deleteRecords.length, 1);
  const { filters } = deleteRecords[0];
  assertEquals(filters.some(f => f.col === 'platform_id'), true);
  assertEquals(filters.some(f => f.col === 'app_user_id'), true);
});

Deno.test('unknown id absent from connections and stealth_connections returns notFound', async () => {
  const UNKNOWN_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 0,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, UNKNOWN_ID, SUBACCOUNT_ID);

  assertEquals(result, { notFound: true });
});
