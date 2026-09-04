/**
 * Contract tests for the unknown Quiltt event type alarm.
 *
 * Pure functions over plain data: no server, no database, no credential.
 * Run with `deno test --no-check --allow-all supabase/functions/`, which is
 * what CI does.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  alarmOnUnknownQuilttEventTypes,
  HANDLED_QUILTT_EVENT_TYPE_PREFIXES,
  isKnownQuilttEventType,
  KNOWN_QUILTT_EVENT_TYPE_PREFIXES,
  MAX_UNKNOWN_ALARMS_PER_BATCH,
  UNKNOWN_EVENT_TYPE_MARKER,
} from './quiltt-event-types.ts';
import { buildRows } from '../or-quiltt-webhook/routing.ts';

interface Emitted {
  warns: string[];
  captures: string[];
}

function recorder(): { sink: { warn: (l: string) => void; capture: (e: Error) => void }; out: Emitted } {
  const out: Emitted = { warns: [], captures: [] };
  return {
    out,
    sink: {
      warn: (l: string) => out.warns.push(l),
      capture: (e: Error) => out.captures.push(e.message),
    },
  };
}

Deno.test('the two dispatched families are known, by name', () => {
  // These are the exact prefixes or-quiltt-sync/handleEvent branches on.
  // Removing either from the list would make every event of that family
  // start alarming as new, which is a silent flip nothing else catches.
  assert(KNOWN_QUILTT_EVENT_TYPE_PREFIXES.includes('connection.synced.successful'));
  assert(KNOWN_QUILTT_EVENT_TYPE_PREFIXES.includes('connection.synced.errored'));
  assertEquals(HANDLED_QUILTT_EVENT_TYPE_PREFIXES.length, 2);

  // Matching is by prefix, so an unlisted subtype of a handled family is not new.
  assert(isKnownQuilttEventType('connection.synced.successful.initial'));
  assert(isKnownQuilttEventType('connection.synced.errored.repairable'));
  assert(isKnownQuilttEventType('connection.synced.errored.some.subtype.invented.later'));
});

Deno.test('a type nobody decided about is unknown', () => {
  // The event this whole change exists for.
  assertEquals(isKnownQuilttEventType('profile.deleted'), false);
  // A bare family name is not one of the two dispatched prefixes either.
  assertEquals(isKnownQuilttEventType('connection.synced'), false);
});

Deno.test('an unknown type produces one greppable line and one capture, carrying type and id only', () => {
  const { sink, out } = recorder();

  const fired = alarmOnUnknownQuilttEventTypes(
    [{ event_id: 'evt_unknown_1', event_type: 'profile.deleted' }],
    sink,
  );

  assertEquals(fired.length, 1);
  assertEquals(out.warns.length, 1);
  assertEquals(out.captures.length, 1);
  assertEquals(out.warns[0], out.captures[0]);
  assert(out.warns[0].includes(UNKNOWN_EVENT_TYPE_MARKER));
  assert(out.warns[0].includes('type=profile.deleted'));
  assert(out.warns[0].includes('event_id=evt_unknown_1'));
});

Deno.test('a known type is silent', () => {
  const { sink, out } = recorder();

  const fired = alarmOnUnknownQuilttEventTypes(
    [
      { event_id: 'evt_a', event_type: 'connection.synced.successful.initial' },
      { event_id: 'evt_b', event_type: 'connection.synced.errored.repairable' },
      { event_id: 'evt_c', event_type: 'profile.created' },
    ],
    sink,
  );

  assertEquals(fired.length, 0);
  assertEquals(out.warns.length, 0);
  assertEquals(out.captures.length, 0);
});

Deno.test('the alarm changes visibility, not behaviour: the unknown event is still stored', () => {
  // Real receiver rows, built by the receiver's own function, so this asserts
  // what actually gets inserted rather than a hand-made stand-in.
  const { rows } = buildRows([
    { id: 'evt_1', type: 'connection.synced.successful.initial', profile: { id: 'p_known' } },
    { id: 'evt_2', type: 'profile.deleted', profile: { id: 'p_gone' } },
  ]);
  const before = JSON.stringify(rows);

  const { sink } = recorder();
  alarmOnUnknownQuilttEventTypes(rows, sink);

  // Same rows, same order, same content. Whatever the caller was going to
  // insert, it still inserts, including the unknown-type event.
  assertEquals(rows.length, 2);
  assertEquals(JSON.stringify(rows), before);
  assertEquals(rows[1].event_id, 'evt_2');
  assertEquals(rows[1].event_type, 'profile.deleted');
});

Deno.test('no payload content, profile id or provider error text reaches the alarm', () => {
  const { sink, out } = recorder();

  const { rows } = buildRows([
    {
      id: 'evt_leak_check',
      type: 'profile.deleted',
      profile: {
        id: 'p_SECRETPROFILE123',
        metadata: { or_subaccount_id: 'sub_SECRETSUBACCOUNT456' },
      },
      // Provider-supplied text of the kind redactProviderError exists for.
      error: 'upstream said: account 987654321 for p_SECRETPROFILE123 is gone',
    } as unknown as Parameters<typeof buildRows>[0][number],
  ]);

  // The row genuinely carries the payload, so the assertions below are about
  // what the alarm reads, not about an input that never had anything to leak.
  assert(JSON.stringify(rows[0].payload).includes('p_SECRETPROFILE123'));

  alarmOnUnknownQuilttEventTypes(rows, sink);

  const emitted = [...out.warns, ...out.captures].join('\n');
  assertEquals(emitted.includes('p_SECRETPROFILE123'), false);
  assertEquals(emitted.includes('sub_SECRETSUBACCOUNT456'), false);
  assertEquals(emitted.includes('987654321'), false);
  assertEquals(emitted.includes('upstream said'), false);
  // What it does carry.
  assert(emitted.includes('type=profile.deleted'));
  assert(emitted.includes('event_id=evt_leak_check'));
});

Deno.test('one alarm per event, even when a batch repeats one', () => {
  const { sink, out } = recorder();

  alarmOnUnknownQuilttEventTypes(
    [
      { event_id: 'evt_dup', event_type: 'profile.deleted' },
      { event_id: 'evt_dup', event_type: 'profile.deleted' },
    ],
    sink,
  );

  assertEquals(out.warns.length, 1);
  assertEquals(out.captures.length, 1);
});

Deno.test('a batch past the cap itemises up to the cap and says how many it did not', () => {
  const { sink, out } = recorder();
  const over = MAX_UNKNOWN_ALARMS_PER_BATCH + 5;

  const fired = alarmOnUnknownQuilttEventTypes(
    Array.from({ length: over }, (_, i) => ({
      event_id: `evt_${i}`,
      event_type: 'some.type.nobody.listed',
    })),
    sink,
  );

  // Every unknown event is still reported to the caller.
  assertEquals(fired.length, over);
  // Itemised alarms are capped, plus exactly one summary line for the rest.
  assertEquals(out.warns.length, MAX_UNKNOWN_ALARMS_PER_BATCH + 1);
  assertEquals(out.captures.length, MAX_UNKNOWN_ALARMS_PER_BATCH + 1);
  assert(out.warns[out.warns.length - 1].includes('5 further unknown-type'));
});

Deno.test('a control character in an upstream type cannot forge a second log line', () => {
  const { sink, out } = recorder();

  alarmOnUnknownQuilttEventTypes(
    [{ event_id: 'evt_x', event_type: 'evil\ntype=connection.synced.successful' }],
    sink,
  );

  assertEquals(out.warns.length, 1);
  assertEquals(out.warns[0].includes('\n'), false);
});
