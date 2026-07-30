import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  chooseProfileId,
  chooseRouting,
  type InboxEventLike,
  metadataSubaccountId,
  profileIdFromPayload,
} from './resolve.ts';

const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const PLAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function ev(
  opts: {
    platform_id?: string | null;
    subaccount_id?: string | null;
    profileId?: unknown;
    metaSub?: unknown;
    extraMeta?: Record<string, unknown>;
  } = {},
): InboxEventLike {
  return {
    platform_id: opts.platform_id ?? null,
    subaccount_id: opts.subaccount_id ?? null,
    payload: {
      profile: {
        id: opts.profileId,
        metadata: { or_subaccount_id: opts.metaSub, ...(opts.extraMeta ?? {}) },
      },
    },
  };
}

Deno.test('routing already on the inbox row is used as is', () => {
  const r = chooseRouting(
    ev({ platform_id: PLAT_A, subaccount_id: SUB_A, metaSub: SUB_B }),
    { platform_id: PLAT_B, subaccount_id: SUB_B },
    { id: SUB_B, platform_id: PLAT_B },
  );

  assertEquals(r, { platform_id: PLAT_A, subaccount_id: SUB_A, source: 'inbox' });
});

Deno.test('a half written inbox row is re-resolved rather than trusted', () => {
  // subaccount without platform is not a routed row, it is a partial write.
  const r = chooseRouting(
    ev({ platform_id: null, subaccount_id: SUB_B }),
    { platform_id: PLAT_A, subaccount_id: SUB_A },
    null,
  );

  assertEquals(r, { platform_id: PLAT_A, subaccount_id: SUB_A, source: 'map' });
});

Deno.test('the profile map wins over profile metadata', () => {
  const r = chooseRouting(
    ev({ profileId: 'p_a', metaSub: SUB_B }),
    { platform_id: PLAT_A, subaccount_id: SUB_A },
    { id: SUB_B, platform_id: PLAT_B },
  );

  assertEquals(r, { platform_id: PLAT_A, subaccount_id: SUB_A, source: 'map' });
});

Deno.test('metadata routes the event when the map lookup found nothing', () => {
  const r = chooseRouting(ev({ profileId: 'p_unmapped', metaSub: SUB_A }), null, {
    id: SUB_A,
    platform_id: PLAT_A,
  });

  assertEquals(r, { platform_id: PLAT_A, subaccount_id: SUB_A, source: 'metadata' });
});

Deno.test('metadata naming a subaccount that does not exist resolves to nothing', () => {
  const r = chooseRouting(ev({ profileId: 'p_x', metaSub: SUB_B }), null, null);

  assertEquals(r, { platform_id: null, subaccount_id: null, source: 'unresolved' });
});

Deno.test('a subaccount row that is not the one the metadata named is refused', () => {
  // The lookup is by id, so this should be impossible. If it ever happens the
  // answer is no routing, not routing onto whichever row came back.
  const r = chooseRouting(ev({ metaSub: SUB_A }), null, { id: SUB_B, platform_id: PLAT_B });

  assertEquals(r, { platform_id: null, subaccount_id: null, source: 'unresolved' });
});

Deno.test('platform_id is never taken from the payload', () => {
  const hostile = ev({
    profileId: 'p_x',
    metaSub: SUB_A,
    extraMeta: { platform_id: PLAT_B, or_tenant: 'someone-else' },
  });

  assertEquals(
    chooseRouting(hostile, null, { id: SUB_A, platform_id: PLAT_A }).platform_id,
    PLAT_A,
    'platform comes off the subaccount row',
  );

  // And with no subaccount row, the platform_id sitting in the payload must not
  // fill the gap. Unresolved is the correct answer.
  //
  // Without this half the assertion above proves nothing about the boundary: it
  // is satisfied by the subaccount row winning, which it always does when the
  // row exists. The guard is only tested where the guard is the only thing
  // between the input and the wrong answer.
  assertEquals(chooseRouting(hostile, null, null), {
    platform_id: null,
    subaccount_id: null,
    source: 'unresolved',
  });
});

Deno.test('non string and empty payload values are not routing answers', () => {
  assertEquals(metadataSubaccountId(ev({ metaSub: 42 })), null);
  assertEquals(metadataSubaccountId(ev({ metaSub: '' })), null);
  assertEquals(profileIdFromPayload(ev({ profileId: { id: 'p_a' } })), null);
  assertEquals(profileIdFromPayload(ev({ profileId: '' })), null);
  assertEquals(
    chooseRouting({ platform_id: null, subaccount_id: null }, null, null).source,
    'unresolved',
  );
});

Deno.test('the map row wins as the profile id for Basic auth', () => {
  const choice = chooseProfileId('p_from_map', ev({ profileId: 'p_from_payload' }));

  assertEquals(choice, { profileId: 'p_from_map', source: 'map' });
});

Deno.test('the payload profile id is used when there is no map row (DL-0465)', () => {
  // This is the whole point. The pre-2026-06-10 cohort has no map row and no
  // way to get one, so without this the event fails on `profile map missing`
  // on every tick, forever, exactly as it did 11,495 times in production.
  const choice = chooseProfileId(null, ev({ profileId: 'p_from_payload' }));

  assertEquals(choice, { profileId: 'p_from_payload', source: 'payload' });
});

Deno.test('no map row and no payload profile id is not a profile id', () => {
  assertEquals(chooseProfileId(null, ev({})), { profileId: null, source: 'none' });
  assertEquals(chooseProfileId('', ev({ profileId: '' })), { profileId: null, source: 'none' });
});
