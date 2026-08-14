/**
 * Deno tests for the or-connection-list stealth union.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-connection-list/stealth-union.test.ts
 *
 * Every line of the union sits behind platform auth, a subaccount lookup and
 * a real stealth row, so a live probe only ever reaches the pre-auth branch.
 * Fixtures reach the projection with no credential, which is why this exists
 * rather than a deployed call.
 *
 * Seven behaviours are pinned. Each is a defect if it regresses, and each is
 * silent in production:
 *
 *   1. `archived` never reaches a consumer. It is not in the `connections`
 *      vocabulary, so emitting it raw is an unknown value in a contract whose
 *      whole point is that there are none.
 *   2. An unrecognised status maps to `error`, never `active`. The failure of
 *      a status map must be a connection that looks broken, not one that
 *      reports healthy while nothing syncs.
 *   3. No envelope, ever. The credential fields are null, and a row carrying
 *      `sealed_envelope` does not smuggle it through under any key.
 *   4. `is_stealth` is a boolean on BOTH families, not present on one and
 *      absent on the other. That is what makes it one shape.
 *   5. `provider_type` is `connection_kind` verbatim, so no new vocabulary is
 *      invented at the boundary.
 *   6. The merged list is newest-first ACROSS families. Concatenating two
 *      sorted lists does not produce a sorted list, and the bug that hides is
 *      a connection made minutes ago rendering below one from July.
 *   7. An unparseable timestamp sorts last, never first. A row with a bad
 *      date must not take the top of the user's list.
 */

import { assertEquals, assertStrictEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isUnmappedStealthStatus,
  mapStealthStatus,
  mergeConnections,
  stealthRowToConnection,
  tagRegularConnection,
} from './stealth-union.ts';
import type { StealthConnectionRow, UnifiedConnection } from './stealth-union.ts';

function stealthRow(extra: Partial<StealthConnectionRow> = {}): StealthConnectionRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    connection_kind: 'xpub_stealth',
    status: 'active',
    last_sync_at: null,
    created_at: '2026-08-14T15:13:52.000Z',
    ...extra,
  };
}

/** Values the `connections.status` CHECK constraint actually allows. */
const CONNECTIONS_STATUS_VOCABULARY = ['pending', 'active', 'error', 'disconnected', 'partial'];

Deno.test('1. archived maps to disconnected and never leaks raw', () => {
  assertEquals(mapStealthStatus('archived'), 'disconnected');

  const projected = stealthRowToConnection(stealthRow({ status: 'archived' }));
  assertEquals(projected.status, 'disconnected');
});

Deno.test('1b. every allowed stealth status lands inside the connections vocabulary', () => {
  // The stealth CHECK constraint allows exactly these three.
  for (const status of ['active', 'error', 'archived']) {
    const mapped = mapStealthStatus(status);
    assertEquals(
      CONNECTIONS_STATUS_VOCABULARY.includes(mapped),
      true,
      `stealth status "${status}" mapped to "${mapped}", which is not a connections status`,
    );
  }
});

Deno.test('1c. active and error pass through unchanged', () => {
  assertEquals(mapStealthStatus('active'), 'active');
  assertEquals(mapStealthStatus('error'), 'error');
});

Deno.test('2. an unrecognised status maps to error, never to active', () => {
  // If OR adds a fourth stealth status and this map is not updated, the row
  // must look broken and get looked at.
  for (const unknown of ['paused', 'syncing', 'ARCHIVED', '', 'active ']) {
    assertEquals(
      mapStealthStatus(unknown),
      'error',
      `unrecognised status "${unknown}" must map to error`,
    );
    assertEquals(isUnmappedStealthStatus(unknown), true);
  }
  assertEquals(isUnmappedStealthStatus('archived'), false);
});

Deno.test('2b. a status colliding with an Object.prototype key does not map to a function', () => {
  // A plain-object lookup would return Object.prototype.constructor here.
  assertEquals(mapStealthStatus('constructor'), 'error');
  assertEquals(mapStealthStatus('toString'), 'error');
  assertEquals(mapStealthStatus('__proto__'), 'error');
});

Deno.test('3. no envelope, and the credential fields are null', () => {
  const rowWithEnvelope = {
    ...stealthRow(),
    // Not in StealthConnectionRow, but prove a widened select cannot leak it.
    sealed_envelope: { version: 1, ciphertext_b64: 'SEALED-DO-NOT-EMIT' },
    wallet_birthday_plaintext: '2024-01-01',
  } as unknown as StealthConnectionRow;

  const projected = stealthRowToConnection(rowWithEnvelope);

  assertStrictEquals(projected.encrypted_credentials, null);
  assertStrictEquals(projected.credentials_key_version, null);
  assertStrictEquals(projected.encrypted_label, null);
  assertStrictEquals(projected.last_sync_cursor, null);
  assertStrictEquals(projected.encrypted_last_error, null);

  // The sharp one: not under its own name, and not under any other key.
  const serialized = JSON.stringify(projected);
  assertEquals(serialized.includes('SEALED-DO-NOT-EMIT'), false);
  assertEquals(serialized.includes('sealed_envelope'), false);
  assertEquals(serialized.includes('wallet_birthday_plaintext'), false);
  assertEquals(Object.keys(projected).includes('sealed_envelope'), false);
});

Deno.test('4. is_stealth is a boolean on both families', () => {
  const stealth = stealthRowToConnection(stealthRow());
  assertStrictEquals(stealth.is_stealth, true);

  const regular = tagRegularConnection({ id: 'abc', provider_type: 'blink' });
  assertStrictEquals(regular.is_stealth, false);
  // Explicitly present, not merely falsy-by-absence.
  assertEquals(Object.keys(regular).includes('is_stealth'), true);
  // And the original row is not mutated.
  assertEquals(regular.provider_type, 'blink');
});

Deno.test('5. provider_type is connection_kind verbatim', () => {
  for (const kind of ['xpub_stealth', 'descriptor_stealth']) {
    assertEquals(stealthRowToConnection(stealthRow({ connection_kind: kind })).provider_type, kind);
  }
});

Deno.test('5b. source_wallets is an empty array, not null and not absent', () => {
  const projected = stealthRowToConnection(stealthRow());
  assertEquals(Array.isArray(projected.source_wallets), true);
  assertEquals(projected.source_wallets.length, 0);
});

Deno.test('6. the merged list is newest-first across families, not concatenated', () => {
  const regular: UnifiedConnection[] = [
    tagRegularConnection({ id: 'bank-aug', created_at: '2026-08-14T11:13:00.000Z' }),
    tagRegularConnection({ id: 'bank-jul', created_at: '2026-07-19T17:11:20.000Z' }),
  ] as unknown as UnifiedConnection[];

  const stealth = [
    stealthRowToConnection(stealthRow({ id: 'sparrow-now', created_at: '2026-08-14T16:00:00.000Z' })),
    stealthRowToConnection(stealthRow({ id: 'sparrow-jun', created_at: '2026-06-01T09:00:00.000Z' })),
  ];

  const merged = mergeConnections(regular, stealth);

  assertEquals(
    merged.map(c => c.id),
    ['sparrow-now', 'bank-aug', 'bank-jul', 'sparrow-jun'],
  );
  // Interleaved, so neither family clumps at an end.
  assertEquals(merged.length, 4);
});

Deno.test('6b. merging with an empty stealth set leaves the regular order untouched', () => {
  const regular: UnifiedConnection[] = [
    tagRegularConnection({ id: 'a', created_at: '2026-08-14T11:13:00.000Z' }),
    tagRegularConnection({ id: 'b', created_at: '2026-07-19T17:11:20.000Z' }),
  ] as unknown as UnifiedConnection[];

  assertEquals(mergeConnections(regular, []).map(c => c.id), ['a', 'b']);
  assertEquals(mergeConnections([], []).length, 0);
});

Deno.test('7. an unparseable or missing created_at sorts last, never first', () => {
  const rows: UnifiedConnection[] = [
    tagRegularConnection({ id: 'broken', created_at: 'not-a-date' }),
    tagRegularConnection({ id: 'missing', created_at: null }),
    tagRegularConnection({ id: 'good', created_at: '2026-08-14T11:13:00.000Z' }),
  ] as unknown as UnifiedConnection[];

  const merged = mergeConnections(rows, []);
  assertEquals(merged[0].id, 'good');
  assertEquals(merged.length, 3);
});
