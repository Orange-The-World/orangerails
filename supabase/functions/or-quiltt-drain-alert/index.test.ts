/**
 * Wiring guards for signal D of or-quiltt-drain-alert (DL-1540).
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-quiltt-drain-alert/index.test.ts
 *
 * These read the source as text rather than invoking the handler. The handler
 * is a Deno.serve entrypoint that builds a Supabase client from environment and
 * calls a SECURITY DEFINER RPC, so exercising it directly means mocking the
 * whole client surface, and a mock deep enough to run it would be asserting on
 * the mock rather than on the alarm. The same approach is used in
 * _shared/providers/_ccxt/index.test.ts and for the same reason.
 *
 * What matters here is not that the code runs, it is that four specific
 * decisions survive a future edit. Each assertion below corresponds to a way
 * this alarm was silent for ten weeks while 246 webhook events were destroyed.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const readSource = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test('signal D counts retired rows, not un-retired ones', () => {
  const src = readSource('./index.ts');

  // The polarity is the whole signal. Signal C uses .is('retirement_reason', null)
  // to EXCLUDE retirements; signal D must use .not(...) to select exactly the
  // rows C skips. Flipping this would produce an alarm that is green precisely
  // when data is being destroyed, which is the state this ticket found.
  assertEquals(
    /\.not\('retirement_reason',\s*'is',\s*null\)/.test(src),
    true,
    "signal D must select rows WHERE retirement_reason IS NOT NULL",
  );
});

Deno.test('signal D windows on processed_at, the retirement timestamp', () => {
  const src = readSource('./index.ts');

  // There is no retired_at column. bumpAttempts writes processed_at and
  // retirement_reason in the same UPDATE, so processed_at IS when we gave up.
  // Windowing on received_at instead would measure when the webhook arrived,
  // which can be many hours earlier, and would silently shift what the alarm
  // reports as recent.
  assertEquals(
    /\.gte\('processed_at',\s*retirementCutoff\)/.test(src),
    true,
    'signal D must window on processed_at, which is the retirement time',
  );
  assertEquals(
    /\.gte\('received_at',\s*retirementCutoff\)/.test(src),
    false,
    'signal D must not window on received_at: that is arrival, not retirement',
  );
});

Deno.test('signal D actually raises the alert', () => {
  const src = readSource('./index.ts');

  // A signal computed and reported but left out of alertFiring is a metric,
  // not an alarm. It would show in the JSON health report and never page
  // anyone, which is indistinguishable from the silence being fixed here.
  assertEquals(
    /const\s+alertFiring\s*=[^;]*retiredFiring/.test(src),
    true,
    'retiredFiring must be part of alertFiring or the signal never pages',
  );
});

Deno.test('any retirement fires: the threshold is zero, not a rate', () => {
  const src = readSource('./index.ts');

  // Signals A uses a percentage because a few failed runs are survivable.
  // A destroyed webhook is not: there is no acceptable background rate of
  // losing a customer's bank data, so this compares against 0 like signal C.
  assertEquals(
    /const\s+retiredFiring\s*=\s*retired\s*!==\s*null\s*&&\s*retired\s*>\s*0/.test(src),
    true,
    'signal D must fire on any retirement at all',
  );
});

Deno.test('signal C still excludes retirements, so D is the only one that sees them', () => {
  const src = readSource('./index.ts');

  // Pinned deliberately. If someone later "fixes" signal C to include retired
  // rows, D becomes a duplicate and the two will double-report. If someone
  // removes D on the assumption C covers it, retirements go invisible again.
  // The two are a pair and this records that.
  assertEquals(
    /\.is\('retirement_reason',\s*null\)/.test(src),
    true,
    'signal C must keep excluding retired rows',
  );
});
