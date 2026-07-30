/**
 * Routing contract for or-quiltt-webhook (DL-0465).
 *
 * The load-bearing test here is "malformed event does not shift routing".
 * It is the one that fails against the previous implementation, and the
 * failure it catches is an event filed under another customer's subaccount.
 *
 * Institution and customer identifiers are deliberately absent: these are
 * synthetic ids only. A public repo keeps fixtures forever.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyRouting, buildRows, type QuilttEventLike } from './routing.ts';

const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const PLAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function ev(
  id: string | null,
  type: string | null,
  profileId?: string,
  metaSub?: string,
): QuilttEventLike {
  return {
    id: id ?? undefined,
    type: type ?? undefined,
    profile: profileId || metaSub
      ? {
        id: profileId,
        metadata: metaSub ? { or_subaccount_id: metaSub } : null,
      }
      : undefined,
  };
}

Deno.test('buildRows drops malformed events and keeps hints aligned', () => {
  const { rows, hints } = buildRows([
    ev(null, 'account.created', 'p_first'), // malformed: no id
    ev('evt_2', 'account.created', 'p_second'),
    ev('evt_3', null, 'p_third'), // malformed: no type
    ev('evt_4', 'balance.created', 'p_fourth'),
  ]);

  assertEquals(rows.length, 2);
  assertEquals(hints.length, 2);
  assertEquals(rows[0].event_id, 'evt_2');
  assertEquals(hints[0].profileId, 'p_second');
  assertEquals(rows[1].event_id, 'evt_4');
  assertEquals(hints[1].profileId, 'p_fourth');
});

Deno.test('a malformed event does not shift routing onto the wrong subaccount', () => {
  // The regression this module exists for. With the old index-based
  // annotation, dropping event 1 meant rows[0] (evt_2, profile B) was
  // annotated from events[0] (profile A) and filed under subaccount A.
  const { rows, hints } = buildRows([
    ev(null, 'account.created', 'p_a'), // dropped
    ev('evt_2', 'account.created', 'p_b'),
  ]);

  const mapping = new Map([
    ['p_a', { platform_id: PLAT_A, subaccount_id: SUB_A }],
    ['p_b', { platform_id: PLAT_B, subaccount_id: SUB_B }],
  ]);

  const counts = applyRouting(rows, hints, mapping, new Map());

  assertEquals(rows.length, 1);
  assertEquals(rows[0].event_id, 'evt_2');
  assertEquals(rows[0].subaccount_id, SUB_B, 'evt_2 belongs to profile B');
  assertEquals(rows[0].platform_id, PLAT_B);
  assertEquals(counts, { viaMap: 1, viaMetadata: 0, unrouted: 0 });
});

Deno.test('the profile map wins when it has an answer', () => {
  const { rows, hints } = buildRows([ev('evt_1', 'account.created', 'p_a', SUB_B)]);
  const mapping = new Map([['p_a', { platform_id: PLAT_A, subaccount_id: SUB_A }]]);
  const metaResolved = new Map([[SUB_B, PLAT_B]]);

  const counts = applyRouting(rows, hints, mapping, metaResolved);

  assertEquals(rows[0].subaccount_id, SUB_A);
  assertEquals(rows[0].platform_id, PLAT_A);
  assertEquals(counts.viaMap, 1);
  assertEquals(counts.viaMetadata, 0);
});

Deno.test('profile metadata routes the event when the map misses', () => {
  // The 360-event production case: no map row anywhere, correct subaccount
  // id sitting in the payload.
  const { rows, hints, metaSubaccountIds } = buildRows([
    ev('evt_1', 'balance.created', 'p_unmapped', SUB_A),
    ev('evt_2', 'profile.ready', 'p_unmapped', SUB_A),
  ]);

  assertEquals(metaSubaccountIds, [SUB_A]);

  const counts = applyRouting(rows, hints, new Map(), new Map([[SUB_A, PLAT_A]]));

  assertEquals(rows[0].subaccount_id, SUB_A);
  assertEquals(rows[0].platform_id, PLAT_A);
  assertEquals(rows[1].subaccount_id, SUB_A);
  assertEquals(counts, { viaMap: 0, viaMetadata: 2, unrouted: 0 });
});

Deno.test('metadata naming an unknown subaccount resolves to nothing, not to something wrong', () => {
  // metaResolved is empty: the caller looked the id up and found no row.
  const { rows, hints } = buildRows([ev('evt_1', 'balance.created', 'p_x', SUB_B)]);

  const counts = applyRouting(rows, hints, new Map(), new Map());

  assertEquals(rows[0].subaccount_id, null);
  assertEquals(rows[0].platform_id, null);
  assertEquals(counts, { viaMap: 0, viaMetadata: 0, unrouted: 1 });
});

Deno.test('platform_id is never taken from the payload', () => {
  // Even if a payload tried to assert its own platform, applyRouting has no
  // channel to read it from: platform_id can only come out of metaResolved,
  // which the caller builds from the subaccounts table.
  const hostile = {
    id: 'evt_1',
    type: 'balance.created',
    profile: {
      id: 'p_x',
      metadata: { or_subaccount_id: SUB_A, or_tenant: 'someone-else', platform_id: PLAT_B },
    },
  } as unknown as QuilttEventLike;

  const { rows, hints } = buildRows([hostile]);
  applyRouting(rows, hints, new Map(), new Map([[SUB_A, PLAT_A]]));

  assertEquals(rows[0].platform_id, PLAT_A, 'platform comes from the subaccount row');
  assertEquals(rows[0].subaccount_id, SUB_A);

  // And when the subaccount lookup came back empty, the platform_id sitting in
  // the payload must not fill the gap. Unrouted is the correct answer.
  //
  // Without this half, an implementation that falls back to the payload passes
  // every other case in this file: the assertions above are satisfied by the
  // validated map winning, which it always does when the subaccount exists.
  const second = buildRows([hostile]);
  const counts = applyRouting(second.rows, second.hints, new Map(), new Map());

  assertEquals(second.rows[0].platform_id, null);
  assertEquals(second.rows[0].subaccount_id, null);
  assertEquals(counts, { viaMap: 0, viaMetadata: 0, unrouted: 1 });
});

Deno.test('an event with no profile at all is unrouted, not crashed on', () => {
  const { rows, hints } = buildRows([{ id: 'evt_1', type: 'profile.created' }]);
  const counts = applyRouting(rows, hints, new Map(), new Map());

  assertEquals(rows.length, 1);
  assertEquals(rows[0].subaccount_id, null);
  assertEquals(counts.unrouted, 1);
});

Deno.test('an all-malformed batch produces no rows', () => {
  const { rows, hints, profileIds, metaSubaccountIds } = buildRows([
    ev(null, null),
    { profile: { id: 'p_a' } },
  ]);

  assertEquals(rows.length, 0);
  assertEquals(hints.length, 0);
  assertEquals(profileIds, []);
  assertEquals(metaSubaccountIds, []);
});

Deno.test('counts partition the batch exactly', () => {
  const { rows, hints } = buildRows([
    ev('evt_1', 'x', 'p_mapped'),
    ev('evt_2', 'x', 'p_unmapped', SUB_A),
    ev('evt_3', 'x', 'p_nothing'),
  ]);

  const counts = applyRouting(
    rows,
    hints,
    new Map([['p_mapped', { platform_id: PLAT_A, subaccount_id: SUB_A }]]),
    new Map([[SUB_A, PLAT_A]]),
  );

  assertEquals(counts, { viaMap: 1, viaMetadata: 1, unrouted: 1 });
  assertEquals(counts.viaMap + counts.viaMetadata + counts.unrouted, rows.length);
});
