/**
 * DL-1480: every sync.completed payload must carry synced_count.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-quiltt-sync/sink-payload.test.ts
 *
 * Source assertions rather than handler invocation. The two enqueue sites sit
 * deep inside handleEvent and handleEventSinkDelivery, behind a provider API
 * call, an OPK seal and several Supabase round trips. A mock deep enough to
 * reach them would be asserting on the mock. What needs protecting here is not
 * the control flow, it is one field surviving in two object literals that must
 * agree with each other.
 *
 * WHY THIS FIELD IS WORTH A TEST OF ITS OWN. Getting it wrong does not fail
 * loudly. Consumers validate a webhook payload before acting on it, and a
 * consumer that does not recognise a shape is entitled to answer 2xx rather
 * than make us retry an event we will never send differently.
 * or-webhook-dispatch marks any 2xx as delivered. So an enqueue missing a
 * contract field produces:
 *
 *   our side    : webhook_delivery row marked succeeded
 *   their side  : nothing recorded
 *   the customer: no data, and nothing anywhere reporting a problem
 *
 * That is a worse outcome than a 400 would have been, because both sides
 * agree it worked. Pinning the field is cheap; rediscovering this is not.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

Deno.test('every sync.completed enqueue carries synced_count', () => {
  // Count the enqueued payload literals, then require the same number of
  // synced_count fields. Counting both sides rather than asserting on one
  // means a THIRD enqueue site added later also has to carry the field,
  // instead of this test silently continuing to pass for the first two.
  const enqueues = (src.match(/event:\s*'sync\.completed'/g) ?? []).length;
  const withCount = (src.match(/synced_count:/g) ?? []).length;

  assertEquals(
    enqueues > 0,
    true,
    'expected at least one sync.completed enqueue in this file',
  );
  assertEquals(
    withCount,
    enqueues,
    `every sync.completed payload must set synced_count: found ${enqueues} enqueues but ${withCount} synced_count fields`,
  );
});

Deno.test('the sink delivery path reports zero rather than omitting the count', () => {
  // Sink delivery pulls nothing itself: the webhook exists to tell the
  // consumer to come and call or-sync. Zero is the honest value there, and
  // it is a number, which is what the field is declared to be. The OPK path
  // reports its real row count because it did pull rows.
  assertEquals(
    /synced_count:\s*0,/.test(src),
    true,
    'the sink delivery payload must send synced_count: 0, not omit the field',
  );
  assertEquals(
    /synced_count:\s*newRows,/.test(src),
    true,
    'the OPK data pull path must keep reporting its real row count',
  );
});
