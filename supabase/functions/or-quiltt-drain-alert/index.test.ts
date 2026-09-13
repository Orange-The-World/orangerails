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

Deno.test('delivery failures retain a bounded reason that names the cause', () => {
  const src = readSource('./index.ts');

  for (
    const [localName, envName] of [
      ['botEmail', 'ZULIP_BOT_EMAIL'],
      ['apiKey', 'ZULIP_API_KEY'],
      ['apiUrl', 'ZULIP_API_URL'],
    ]
  ) {
    assertEquals(
      new RegExp(`!${localName}\\s*\\?\\s*'${envName}'\\s*:\\s*null`).test(src),
      true,
      `missing ${envName} must be detected and named`,
    );
  }
  assertEquals(
    /`HTTP \$\{res\.status\}: \$\{text\.slice\(0, 200\)\}`/.test(src),
    true,
    'HTTP failures must retain the status and at most the first 200 body characters',
  );
});

Deno.test('delivery state read errors are surfaced and fail towards posting', () => {
  const src = readSource('./index.ts');

  assertEquals(
    src.includes("const { data: stateRow, error: stateReadErr }"),
    true,
    'the cooldown state read must retain its error',
  );
  assertEquals(
    src.includes(".select('last_notified_at, consecutive_failures')"),
    true,
    'the state read must load both the cooldown timestamp and delivery failure count',
  );
  assertEquals(
    src.includes('state read failed: ${stateReadErr.message}'),
    true,
    'the response must carry a failed state read',
  );
  assertEquals(
    /const\s+lastNotifiedAt[^=]*=\s*stateReadErr\s*\?\s*null/.test(src),
    true,
    'a failed state read must ignore partial data and bypass cooldown',
  );
});

Deno.test('failed posts remain outside cooldown and increment durable failure health', () => {
  const src = readSource('./index.ts');
  const stateWrite = src.slice(
    src.indexOf('const { error: stateWriteErr }'),
    src.indexOf('const report: HealthReport'),
  );

  assertEquals(
    /const\s+withinCooldown\s*=\s*lastNotifiedAt\s*!==\s*null[^;]*lastNotifiedAt/.test(src),
    true,
    'cooldown must remain keyed only to last_notified_at',
  );
  assertEquals(
    stateWrite.includes('...(postResult.sent ? { last_notified_at: checkedAt } : {})'),
    true,
    'a failed post must not advance last_notified_at',
  );
  assertEquals(
    /last_attempt_at:\s*checkedAt/.test(stateWrite),
    true,
    'every actual post attempt must persist its timestamp',
  );
  assertEquals(
    /last_error:\s*postResult\.error\s*\?\?\s*null/.test(stateWrite),
    true,
    'the durable attempt row must retain the short delivery error',
  );
  assertEquals(
    stateWrite.includes('consecutive_failures: nextConsecutiveFailures'),
    true,
    'every actual post attempt must persist delivery failure health',
  );
  assertEquals(
    /postResult\.sent\s*\?\s*0\s*:\s*\(stateReadErr\s*\?\s*0\s*:\s*\(stateRow\?\.consecutive_failures\s*\?\?\s*0\)\)\s*\+\s*1/.test(src),
    true,
    'success must reset the counter and failure must increment it',
  );
});

Deno.test('state write failures and delivery health are present in the report', () => {
  const src = readSource('./index.ts');

  assertEquals(
    src.includes('state write failed: ${stateWriteErr.message}'),
    true,
    'the durable attempt write error must not be discarded',
  );
  assertEquals(src.includes('delivery_health: {'), true);
  assertEquals(src.includes('attempted: deliveryAttempted'), true);
  assertEquals(src.includes('suppressed_by_cooldown: deliverySuppressed'), true);
  assertEquals(src.includes('consecutive_failures: consecutiveFailures'), true);
  assertEquals(src.includes('state_error: deliveryStateError'), true);
});

Deno.test('migration adds a non-negative consecutive delivery failure counter', () => {
  const migration = readSource('../../migrations/20260913030000_drain_alert_delivery_failure_counter.sql');

  assertEquals(
    /ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0/.test(migration),
    true,
  );
  assertEquals(/CHECK \(consecutive_failures >= 0\)/.test(migration), true);
});
