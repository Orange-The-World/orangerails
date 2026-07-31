/**
 * Deno tests for the or-quiltt-accounts response contract (DL-0326).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-quiltt-accounts/transform.test.ts
 *
 * These assert the part of #303 that deployment could not prove. Every line
 * that PR changed sits behind platform auth and a Quiltt credential, so the
 * live probes only ever reached the pre-auth branch. Fixtures reach the rest
 * with no credential, which is why this exists rather than a sandbox call.
 *
 * Four behaviours are pinned, each of which is a defect if it regresses and
 * each of which is silent in production:
 *
 *   1. Nothing caps the account count. The ticket was opened as "capped at
 *      18", so the reported shape (3 accounts on one connection plus 18 on
 *      another) is pinned as a fixture, under generic institution names.
 *   2. Only CLOSED is excluded. A state Quiltt adds later must survive.
 *   3. A null state is included, not dropped.
 *   4. Connection status is passed through per account, unmapped, so
 *      ERROR_REPAIRABLE cannot read as healthy.
 *   5. The profile-wide account set is the union of Quiltt's two roots, in
 *      both directions, so an undocumented default on either one cannot
 *      silently shorten the answer.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildAccountsResponse, mergeAccountSets } from './transform.ts';
import type { QuilttAccount } from './transform.ts';

function acct(
  id: string,
  state: string | null,
  extra: Partial<QuilttAccount> = {},
): QuilttAccount {
  return {
    id,
    name: `Account ${id}`,
    mask: '0000',
    kind: 'CHECKING',
    state,
    currencyCode: 'USD',
    institution: { name: 'Test Bank' },
    balance: { current: 100, available: 90 },
    connection: { id: 'conn-1', status: 'SYNCED' },
    ...extra,
  };
}

// 1. The ticket's own shape: 21 accounts across two connections, nothing capped.
//
// The institution names below are deliberately generic. This repo is public and
// its history is permanent, so a fixture must not publish which banks a real
// customer holds accounts at. No assertion reads the institution name, so the
// names carry no meaning here. Do not "correct" them back to the real ones.

Deno.test('DL-0326: 21 accounts across two connections all come back, nothing caps at 18', () => {
  const healthy = Array.from({ length: 3 }, (_, i) =>
    acct(`bank-a-${i}`, 'OPEN', {
      institution: { name: 'Bank A' },
      connection: { id: 'conn-a', status: 'SYNCED' },
    }));
  const broken = Array.from({ length: 18 }, (_, i) =>
    acct(`bank-b-${i}`, 'OPEN', {
      institution: { name: 'Bank B' },
      connection: { id: 'conn-b', status: 'ERROR_REPAIRABLE' },
    }));

  const out = buildAccountsResponse([...healthy, ...broken]);

  assertEquals(out.accounts.length, 21);
  assertEquals(out.total_returned, 21);
  assertEquals(out.excluded_closed, 0);
  assertEquals(out.distinct_states, ['OPEN']);
});

// 2. The denylist. Only CLOSED goes, and an unknown future state survives.

Deno.test('only CLOSED is excluded', () => {
  const out = buildAccountsResponse([
    acct('a', 'OPEN'),
    acct('b', 'CLOSED'),
    acct('c', 'OPEN'),
  ]);

  assertEquals(out.accounts.map((a) => a.id), ['a', 'c']);
  assertEquals(out.total_returned, 3);
  assertEquals(out.excluded_closed, 1);
});

Deno.test('a state we have never seen is returned, not dropped', () => {
  // The old code allowlisted OPEN|ACTIVE. If Quiltt adds a member, an
  // allowlist silently drops it. This is the regression that must not return.
  const out = buildAccountsResponse([
    acct('a', 'OPEN'),
    acct('b', 'PENDING_VERIFICATION'),
  ]);

  assertEquals(out.accounts.length, 2);
  assertEquals(out.accounts.map((a) => a.state), ['OPEN', 'PENDING_VERIFICATION']);
  assertEquals(out.excluded_closed, 0);
});

// 3. Null state fails open.
//
// Quiltt declares `Account.state` as `AccountState!`, NON_NULL, VERIFIED by
// introspection against prod. OR types it `string | null` anyway. Those are not
// in conflict: the schema states the obligation the vendor has undertaken, and
// our type states what this handler is prepared to survive if the vendor breaks
// it. Under a conformant response the branch below is unreachable.
//
// It is asserted regardless, because the cost of the two failure modes is not
// symmetric. If the branch is dead we have one cheap test. If it is ever live
// and we deleted it as unreachable, a vendor schema violation turns into silent
// data loss on a ticket that exists because accounts went missing silently.

Deno.test('a null state is included, and shows up in distinct_states', () => {
  const out = buildAccountsResponse([acct('a', 'OPEN'), acct('b', null)]);

  assertEquals(out.accounts.length, 2);
  assertEquals(out.accounts.map((a) => a.id), ['a', 'b']);
  assertEquals(out.distinct_states, ['OPEN', null]);
  assertEquals(out.excluded_closed, 0);
});

// 4. Connection status, per account, unmapped.

Deno.test('connection id and status are passed through unmapped', () => {
  const out = buildAccountsResponse([
    acct('a', 'OPEN', { connection: { id: 'conn-x', status: 'ERROR_REPAIRABLE' } }),
  ]);

  assertEquals(out.accounts[0].connection, { id: 'conn-x', status: 'ERROR_REPAIRABLE' });
});

Deno.test('a missing connection maps to null rather than throwing', () => {
  const out = buildAccountsResponse([
    acct('a', 'OPEN', { connection: null }),
    acct('b', 'OPEN', { connection: undefined }),
  ]);

  assertEquals(out.accounts[0].connection, null);
  assertEquals(out.accounts[1].connection, null);
});

Deno.test('accounts from different connections keep their own status', () => {
  // The all-connections mode flattens across connections, which is why status
  // is per account and not a single top-level field.
  const out = buildAccountsResponse([
    acct('a', 'OPEN', { connection: { id: 'conn-1', status: 'SYNCED' } }),
    acct('b', 'OPEN', { connection: { id: 'conn-2', status: 'ERROR_INSTITUTION' } }),
  ]);

  assertEquals(out.accounts[0].connection?.status, 'SYNCED');
  assertEquals(out.accounts[1].connection?.status, 'ERROR_INSTITUTION');
});

// 5. Field mapping and empty input.

Deno.test('optional vendor fields map to null instead of undefined', () => {
  const out = buildAccountsResponse([
    acct('a', 'OPEN', { institution: null, balance: null, mask: null, kind: null, currencyCode: null }),
  ]);

  assertEquals(out.accounts[0], {
    id: 'a',
    name: 'Account a',
    institution_name: null,
    kind: null,
    mask: null,
    currency: null,
    state: 'OPEN',
    balance_current: null,
    balance_available: null,
    connection: { id: 'conn-1', status: 'SYNCED' },
  });
});

Deno.test('an empty account list returns counters, not undefined', () => {
  const out = buildAccountsResponse([]);

  assertEquals(out.accounts, []);
  assertEquals(out.total_returned, 0);
  assertEquals(out.excluded_closed, 0);
  assertEquals(out.distinct_states, []);
});

Deno.test('counters describe the set before filtering', () => {
  const out = buildAccountsResponse([
    acct('a', 'OPEN'),
    acct('b', 'CLOSED'),
    acct('c', 'CLOSED'),
    acct('d', null),
  ]);

  assertEquals(out.accounts.length, 2);
  assertEquals(out.total_returned, 4);
  assertEquals(out.excluded_closed, 2);
  assertEquals(out.distinct_states, ['OPEN', 'CLOSED', null]);
});

// The profile-wide union.
//
// The endpoint's no-connection-id mode means "every account under this
// profile". Quiltt exposes two roots that each claim to list them, root
// `accounts` and the accounts under each `connections` entry, and the public
// schema reference documents neither one's no-filter default. These pin the
// union, in both directions, so that whichever root turns out to be the
// filtered one, no account is dropped.

Deno.test('the union keeps an account that only the root accounts field listed', () => {
  const merged = mergeAccountSets([acct('a', 'OPEN'), acct('b', 'OPEN')], [acct('b', 'OPEN')]);

  assertEquals(merged.accounts.map((a) => a.id), ['a', 'b']);
  assertEquals(merged.only_in_root, ['a']);
  assertEquals(merged.only_in_connections, []);
});

Deno.test('the union keeps an account that only the connections flatten listed', () => {
  const merged = mergeAccountSets([acct('b', 'OPEN')], [acct('b', 'OPEN'), acct('c', 'OPEN')]);

  assertEquals(merged.accounts.map((a) => a.id), ['b', 'c']);
  assertEquals(merged.only_in_root, []);
  assertEquals(merged.only_in_connections, ['c']);
});

Deno.test('agreeing sources do not duplicate and report no disagreement', () => {
  const both = [acct('a', 'OPEN'), acct('b', 'OPEN')];
  const merged = mergeAccountSets(both, [...both]);

  assertEquals(merged.accounts.map((a) => a.id), ['a', 'b']);
  assertEquals(merged.only_in_root, []);
  assertEquals(merged.only_in_connections, []);
});

// This is the ticket's own hypothesis as a fixture. If `connections` omits a
// connection in an error state, flattening it loses that connection's accounts
// entirely, and the caller sees 3 accounts where the user has 21. The union is
// what makes that survivable without knowing which root filters.
Deno.test('DL-0326: a broken connection missing from the connections list still yields its accounts', () => {
  const healthy = Array.from({ length: 3 }, (_, i) =>
    acct(`bank-a-${i}`, 'OPEN', { connection: { id: 'conn-a', status: 'SYNCED' } }));
  const broken = Array.from({ length: 18 }, (_, i) =>
    acct(`bank-b-${i}`, 'OPEN', { connection: { id: 'conn-b', status: 'ERROR_REPAIRABLE' } }));

  const merged = mergeAccountSets([...healthy, ...broken], healthy);
  const out = buildAccountsResponse(
    merged.accounts,
    merged.only_in_root.length + merged.only_in_connections.length,
  );

  assertEquals(out.accounts.length, 21);
  assertEquals(out.total_returned, 21);
  assertEquals(out.source_disagreement, 18);
});

// The mirror of the above. The fix must not trade one undocumented default for
// the other, so the same 21 accounts survive when it is the root field that is
// short.
Deno.test('DL-0326: the union is symmetric, a short root accounts field loses nothing either', () => {
  const healthy = Array.from({ length: 3 }, (_, i) =>
    acct(`bank-a-${i}`, 'OPEN', { connection: { id: 'conn-a', status: 'SYNCED' } }));
  const broken = Array.from({ length: 18 }, (_, i) =>
    acct(`bank-b-${i}`, 'OPEN', { connection: { id: 'conn-b', status: 'ERROR_REPAIRABLE' } }));

  const merged = mergeAccountSets(healthy, [...healthy, ...broken]);
  const out = buildAccountsResponse(
    merged.accounts,
    merged.only_in_root.length + merged.only_in_connections.length,
  );

  assertEquals(out.accounts.length, 21);
  assertEquals(out.source_disagreement, 18);
});

Deno.test('a CLOSED account reaching the union is still excluded from the response', () => {
  const merged = mergeAccountSets([acct('a', 'OPEN')], [acct('b', 'CLOSED')]);
  const out = buildAccountsResponse(merged.accounts, 2);

  assertEquals(merged.accounts.length, 2);
  assertEquals(out.accounts.map((a) => a.id), ['a']);
  assertEquals(out.excluded_closed, 1);
  assertEquals(out.total_returned, 2);
  assertEquals(out.source_disagreement, 2);
});

Deno.test('two empty sources merge to empty rather than undefined', () => {
  const merged = mergeAccountSets([], []);

  assertEquals(merged.accounts, []);
  assertEquals(merged.only_in_root, []);
  assertEquals(merged.only_in_connections, []);
});

// The single-connection path has one source, so it must not report a
// disagreement it cannot have measured.
Deno.test('source_disagreement defaults to 0 for the single-connection path', () => {
  const out = buildAccountsResponse([acct('a', 'OPEN')]);

  assertEquals(out.source_disagreement, 0);
});
