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
  buildListResponse,
  isUnmappedStealthStatus,
  mapStealthStatus,
  mergeConnections,
  SOURCE_WALLETS_UNAVAILABLE_ALARM,
  STEALTH_UNAVAILABLE_ALARM,
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
    last_block_scanned: null,
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

Deno.test('8. stealth_unavailable is always a boolean, never omitted on success', () => {
  const ok = buildListResponse([], false, false);
  assertStrictEquals(ok.stealth_unavailable, false);
  assertStrictEquals(ok.source_wallets_unavailable, false);
  // Present, not merely falsy-by-absence. A key that only shows up on
  // failure is a key clients forget to check.
  assertEquals(Object.keys(ok).includes('stealth_unavailable'), true);
  assertEquals(Object.keys(ok).includes('source_wallets_unavailable'), true);
  assertEquals(JSON.parse(JSON.stringify(ok)).stealth_unavailable, false);
  assertEquals(JSON.parse(JSON.stringify(ok)).source_wallets_unavailable, false);

  const degraded = buildListResponse([], true, false);
  assertStrictEquals(degraded.stealth_unavailable, true);
  assertStrictEquals(degraded.source_wallets_unavailable, false);

  const walletDegraded = buildListResponse([], false, true);
  assertStrictEquals(walletDegraded.stealth_unavailable, false);
  assertStrictEquals(walletDegraded.source_wallets_unavailable, true);
});

Deno.test('8b. degradation does not drop the connections that were readable', () => {
  const regular = [
    tagRegularConnection({ id: 'bank', created_at: '2026-08-14T11:13:00.000Z' }),
  ] as unknown as UnifiedConnection[];

  const degraded = buildListResponse(regular, true, false);
  // The whole point of degrading rather than failing closed.
  assertEquals(degraded.connections.map(c => c.id), ['bank']);
  assertStrictEquals(degraded.stealth_unavailable, true);
  assertStrictEquals(degraded.source_wallets_unavailable, false);
});

Deno.test('9. the alarm token is a bare greppable literal', () => {
  // One GlitchTip alarm has to catch every degrade site, so this string is a
  // contract with the alarm, not a message. Changing it silently breaks the
  // alarm while every test still passes, which is why its exact value is
  // pinned here.
  assertEquals(STEALTH_UNAVAILABLE_ALARM, 'STEALTH_UNION_UNAVAILABLE');
  // No whitespace, punctuation or interpolation, so it survives log
  // formatting and greps as a literal.
  assertEquals(/^[A-Z_]+$/.test(STEALTH_UNAVAILABLE_ALARM), true);
});

Deno.test('9c. the source_wallets alarm token is a bare greppable literal', () => {
  assertEquals(SOURCE_WALLETS_UNAVAILABLE_ALARM, 'SOURCE_WALLETS_UNAVAILABLE');
  assertEquals(/^[A-Z_]+$/.test(SOURCE_WALLETS_UNAVAILABLE_ALARM), true);
});

Deno.test('10. sync progress is two fields, never one coerced into the other', () => {
  // A block height stringified into a cursor field is a lying value: a
  // consumer that treats the cursor as opaque and hands it back to a provider
  // would ship it a number. Null is honest and branchable. A wrong number is
  // the one outcome nobody can detect later.
  const stealth = stealthRowToConnection(stealthRow({ last_block_scanned: 862_144 }));
  assertStrictEquals(stealth.last_block_scanned, 862_144);
  assertStrictEquals(stealth.last_sync_cursor, null);
  // The height must stay a number, not be stringified anywhere en route.
  assertEquals(typeof stealth.last_block_scanned, 'number');

  const regular = tagRegularConnection({ id: 'bank', last_sync_cursor: 'quiltt-opaque-cursor' });
  assertStrictEquals(regular.last_block_scanned, null);
  assertStrictEquals(regular.last_sync_cursor, 'quiltt-opaque-cursor');
  // Present as an explicit null, not absent.
  assertEquals(Object.keys(regular).includes('last_block_scanned'), true);
});

Deno.test('10b. a stealth row that has never scanned reports null, not zero', () => {
  // Block 0 is the genesis block, so a synthesized 0 would read as "scanned
  // the whole chain from the start" rather than "no scan has run".
  const neverScanned = stealthRowToConnection(stealthRow({ last_block_scanned: null }));
  assertStrictEquals(neverScanned.last_block_scanned, null);

  // And a genuine 0 must survive rather than being nulled by a falsy check.
  const atGenesis = stealthRowToConnection(stealthRow({ last_block_scanned: 0 }));
  assertStrictEquals(atGenesis.last_block_scanned, 0);
});

Deno.test('10c. the handler actually selects last_block_scanned', async () => {
  // Structural guard, same reasoning as 9b. If the column is dropped from the
  // SELECT, the field silently becomes null for every stealth row and every
  // unit test here still passes, because the projection is fed fixtures. A
  // field that is null because nobody asked for it is indistinguishable from
  // a field that is null because the row has no value.
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

  // Matched inside the stealth select specifically, not merely present
  // somewhere in the file where a comment mentioning it would satisfy it.
  const stealthSelect = source.match(/\.from\('stealth_connections'\)\s*\n\s*\.select\('([^']+)'\)/);
  assertEquals(stealthSelect !== null, true, 'could not locate the stealth_connections select');

  const columns = stealthSelect![1].split(',').map(s => s.trim());
  assertEquals(
    columns.includes('last_block_scanned'),
    true,
    `last_block_scanned missing from the stealth select: ${stealthSelect![1]}`,
  );
  // The other columns the projection reads, for the same reason.
  for (const required of ['id', 'connection_kind', 'status', 'last_sync_at', 'created_at']) {
    assertEquals(columns.includes(required), true, `${required} missing from the stealth select`);
  }
  // And the envelope must never be added to it.
  assertEquals(columns.includes('sealed_envelope'), false);
});

Deno.test('9b. every degrade site in the handler carries the alarm token', async () => {
  // A structural guard, not a unit test, and deliberately so. The failure it
  // catches is a future edit that adds a third degrade path and logs it
  // without the token: the endpoint would degrade silently, the GlitchTip
  // alarm would never fire, and every other test here would still pass.
  //
  // Resolved relative to this module so it does not depend on the cwd the
  // test runner happens to use.
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const lines = source.split('\n');

  const degradeSites = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\bstealthUnavailable\s*=\s*true\b/.test(line));

  // If this drops to zero the test has stopped testing anything, which is
  // the failure mode of every source-scanning check.
  assertEquals(
    degradeSites.length >= 2,
    true,
    `expected at least the 2 known degrade sites, found ${degradeSites.length}`,
  );

  for (const { i } of degradeSites) {
    const window = lines.slice(i, i + 6).join('\n');
    assertEquals(
      window.includes('STEALTH_UNAVAILABLE_ALARM'),
      true,
      `degrade site at index.ts:${i + 1} does not log STEALTH_UNAVAILABLE_ALARM within 6 lines`,
    );
  }
});

Deno.test('9d. every source_wallets degrade site carries the SOURCE_WALLETS_UNAVAILABLE_ALARM token', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const lines = source.split('\n');

  const degradeSites = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\bsourceWalletsUnavailable\s*=\s*true\b/.test(line));

  assertEquals(
    degradeSites.length >= 1,
    true,
    `expected at least 1 sourceWalletsUnavailable degrade site, found ${degradeSites.length}`,
  );

  for (const { i } of degradeSites) {
    const window = lines.slice(i, i + 6).join('\n');
    assertEquals(
      window.includes('SOURCE_WALLETS_UNAVAILABLE_ALARM'),
      true,
      `degrade site at index.ts:${i + 1} does not log SOURCE_WALLETS_UNAVAILABLE_ALARM within 6 lines`,
    );
  }
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
