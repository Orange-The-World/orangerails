import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  chooseProfileId,
  chooseRouting,
  type InboxEventLike,
  metadataSubaccountId,
  profileIdFromPayload,
  redactProviderError,
  redactProviderId,
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

Deno.test('the map supplies the profile id when it agrees with the event', () => {
  const choice = chooseProfileId('p_same', ev({ profileId: 'p_same' }), SUB_A);

  assertEquals(choice, { profileId: 'p_same', source: 'map' });
});

Deno.test('a rebound subaccount does not override the profile that sent the event', () => {
  // The legacy subaccount later called or-quiltt-session, which found no map
  // row, minted a fresh Quiltt profile and mapped that one to it. handleEvent
  // reads the map by subaccount_id, so it sees the new profile. The event still
  // belongs to the old one, and only the old one's Basic credential can read the
  // old connection.
  //
  // Preferring the map here is not a cosmetic wrong answer. It authenticates as
  // a profile that cannot see this event's connection, so the event fails, bumps
  // its counter, and holds a slot in the oldest-first drain forever: the same
  // forever-loop this module exists to end, reintroduced one layer up.
  const choice = chooseProfileId(
    'p_minted_later',
    ev({ profileId: 'p_that_sent_this', metaSub: SUB_A }),
    SUB_A,
  );

  assertEquals(choice, { profileId: 'p_that_sent_this', source: 'payload-rebound' });
});

Deno.test('the map still answers when the event names no profile of its own', () => {
  // The inverse boundary. Without this the rule above reads as "the payload
  // always wins", and an event carrying no profile would resolve to nothing even
  // though the map knows the answer.
  assertEquals(chooseProfileId('p_from_map', ev({}), SUB_A), {
    profileId: 'p_from_map',
    source: 'map',
  });
});

Deno.test('the payload profile id is used when there is no map row (DL-0465)', () => {
  // This is the whole point. The pre-2026-06-10 cohort has no map row and no
  // way to get one, so without this the event fails on `profile map missing`
  // on every tick, forever, exactly as it did 11,495 times in production.
  //
  // Their metadata names the same subaccount they route to, which is what earns
  // them the payload credential under the rule below.
  const choice = chooseProfileId(
    null,
    ev({ profileId: 'p_from_payload', metaSub: SUB_A }),
    SUB_A,
  );

  assertEquals(choice, { profileId: 'p_from_payload', source: 'payload' });
});

Deno.test('a payload profile is refused when it names a different subaccount', () => {
  // A row misrouted by the receiver's old malformed-batch index shift: the
  // stored route is COMPLETE, so chooseRouting trusts it, and it points at
  // SUB_B. The map read by SUB_B returns SUB_B's own profile, which differs
  // from the payload's, so this looks exactly like a rebind.
  //
  // It is not one, and the difference is not cosmetic. The payload's credential
  // WORKS: it returns the real customer's transactions, which index.ts then
  // seals under SUB_B's OPK. Preferring the map fails closed instead, because
  // SUB_B's profile cannot read this event's connection. Refusing outright is
  // the same fail-closed without pretending we know whose data this is.
  const choice = chooseProfileId(
    'p_belonging_to_sub_b',
    ev({ profileId: 'p_that_sent_this', metaSub: SUB_A }),
    SUB_B,
  );

  assertEquals(choice, { profileId: null, source: 'route-conflict' });
});

Deno.test('the refusal also covers a misroute where the map simply misses', () => {
  // Same misroute, but SUB_B has no map row at all. Without this fixture the
  // guard can be written to cover only the rebound branch, which is where the
  // finding was reported, and this case walks straight through it into the
  // identical leak via source 'payload'. The guard has to sit on both payload
  // paths, so a fixture has to exist for both.
  const choice = chooseProfileId(
    null,
    ev({ profileId: 'p_that_sent_this', metaSub: SUB_A }),
    SUB_B,
  );

  assertEquals(choice, { profileId: null, source: 'route-conflict' });
});

Deno.test('a payload that names no subaccount corroborates nothing', () => {
  // Silence is not agreement. Without this the guard can be written as
  // "refuse only when the metadata names a DIFFERENT subaccount", and every
  // metadata-free event goes back to handing its payload credential over on
  // trust, which is the hole this was opened to close.
  const choice = chooseProfileId(null, ev({ profileId: 'p_that_sent_this' }), SUB_A);

  assertEquals(choice, { profileId: null, source: 'route-conflict' });
});

Deno.test('no map row and no payload profile id is not a profile id', () => {
  assertEquals(chooseProfileId(null, ev({}), SUB_A), { profileId: null, source: 'none' });
  assertEquals(chooseProfileId('', ev({ profileId: '' }), SUB_A), {
    profileId: null,
    source: 'none',
  });
});

Deno.test('redactProviderId keeps the type and drops the identity', () => {
  assertEquals(redactProviderId('p_12zb3n94iKR1drzFbVK6qF'), 'p_[redacted]');
  assertEquals(redactProviderId('conn_14TJiFDKRJlPiBHuukUIlXZ'), 'conn_[redacted]');

  // Two different profiles have to render identically. If they did not, the log
  // line would still carry enough to tell one customer's profile from another.
  assertEquals(
    redactProviderId('p_aaaaaaaaaaaaaaaaaaaaaa'),
    redactProviderId('p_bbbbbbbbbbbbbbbbbbbbbb'),
  );

  // A UUID is not a provider id and is not this function's job. Subaccount ids
  // are ours, and index.ts logs them deliberately so an operator can find the
  // row the warning is about.
  assertEquals(redactProviderId(SUB_A), SUB_A);
  assertEquals(redactProviderId(''), '');
});

Deno.test('redactProviderError redacts both id shapes and honours the limit', () => {
  assertEquals(
    redactProviderError('no such connection conn_14TJiFDKRJlPiBHuukUIlXZ', 400),
    'no such connection conn_[redacted]',
  );
  // The numeric pass runs on top of the prefix pass, not instead of it.
  assertEquals(redactProviderError('member 998877665544 refused', 400), 'member [redacted] refused');
  assertEquals(redactProviderError('', 400), '');
  assertEquals(redactProviderError('abcdef', 3), 'abc');
});

Deno.test('redaction runs before the length limit, so a cut cannot expose a fragment', () => {
  // The identifier is positioned so the limit falls inside it. Truncating first
  // would leave `conn_14T`, and `[A-Za-z0-9]{6,}` needs six characters after the
  // underscore, so that fragment would no longer match and would survive.
  const raw = 'e'.repeat(20) + ' conn_14TJiFDKRJlPiBHuukUIlXZ';

  assertEquals(redactProviderError(raw, 29), 'e'.repeat(20) + ' conn_[re');

  // Stronger than one cut point: no limit anywhere may leave an identity
  // character behind the prefix. Redacting first makes `[` the only thing that
  // can ever follow `conn_`; truncating first leaks for five of these.
  for (let max = 1; max <= raw.length + 5; max++) {
    const out = redactProviderError(raw, max);
    assert(
      !/conn_[A-Za-z0-9]/.test(out),
      `identity survived the limit at max=${max}: ${out}`,
    );
  }

  // Same property for the numeric pass, and the assertion has to be "no digit
  // at all" rather than "no run of six". A cut leaving five digits defeats the
  // {6,} pattern, so testing for the pattern would pass on the very input that
  // leaks.
  const digits = 'x'.repeat(10) + ' 998877665544';
  for (let max = 1; max <= digits.length + 5; max++) {
    const out = redactProviderError(digits, max);
    assert(!/\d/.test(out), `a digit survived the limit at max=${max}: ${out}`);
  }
});

Deno.test('redactProviderError is idempotent, so a second pass cannot mangle its own output', () => {
  // #333 moves redaction to the single entry point that writes last_error and
  // retirement_reason. Two of the returns arriving there are already redacted
  // (the non-ok and GraphQL-errors branches redact before returning), so the
  // entry redactor sees clean text on those paths and must leave it alone.
  //
  // The property holds because the replacement inserts '[', which is outside
  // [A-Za-z0-9], so the pattern cannot re-enter its own output. That is a
  // property of the replacement string, and a later change to it could break
  // this without touching anything the other fixtures assert.
  const inputs = [
    'connection lookup failed: conn_14TJiFDKRJlPiBHuukUIlXZ',
    'profile map lookup failed: p_EXAMPLE0000000',
    'reference 998877665544 not found',
    'conn_14TJiFDKRJlPiBHuukUIlXZ and p_EXAMPLE0000000 and 998877665544',
    'Quiltt GraphQL 502: upstream conn_[redacted] is down, ref [redacted]',
    'conn_[redacted]',
    '[redacted]',
    'no identifiers here at all',
    '',
    'x'.repeat(600) + ' conn_14TJiFDKRJlPiBHuukUIlXZ',
  ];

  for (const input of inputs) {
    const once  = redactProviderError(input, 500);
    const twice = redactProviderError(once, 500);
    assertEquals(twice, once, `not idempotent for input: ${input.slice(0, 60)}`);
  }
});
