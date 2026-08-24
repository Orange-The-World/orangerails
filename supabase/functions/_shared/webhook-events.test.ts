/**
 * DL-1565: every sync.completed emitter must send the same payload shape.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/_shared/webhook-events.test.ts
 *
 * WHY THIS FILE EXISTS, AND WHY IT SCANS THE REPO RATHER THAN ONE FUNCTION.
 *
 * Five separate places used to build this payload as an inline object
 * literal, and they had drifted into three different shapes. Two of the five
 * were fixed individually, in two different PRs, for two different missing
 * fields, and the drift continued anyway because nothing stopped a sixth site
 * from being written the old way. A test that pins one function cannot catch
 * that. This one enumerates the emitters and fails when a new one appears
 * that does not go through the shared builder.
 *
 * Getting the shape wrong does not fail loudly, which is what makes it worth
 * a test. Consumers validate a webhook payload before acting on it, and a
 * consumer that does not recognise a shape is entitled to answer 2xx rather
 * than make us retry an event we will never send differently.
 * or-webhook-dispatch marks any 2xx as delivered. So a malformed enqueue
 * produces:
 *
 *   our side    : webhook_delivery row marked succeeded
 *   their side  : nothing recorded
 *   the customer: no data, and nothing anywhere reporting a problem
 *
 * That is a worse outcome than a 400, because both sides agree it worked.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildSyncCompletedPayload } from './webhook-events.ts';

// ── the payload itself ────────────────────────────────────────────────

Deno.test('data matches SyncCompletedEvent[data] in the published SDK exactly', () => {
  // Read the SDK's own type rather than restating it here. A test that
  // repeats the field list is a second place to forget to update; this one
  // fails the moment the two disagree in either direction.
  const typesPath = new URL(
    '../../../packages/webhooks/src/types.ts',
    import.meta.url,
  );
  const types = Deno.readTextFileSync(typesPath);
  const block = types.match(
    /export interface SyncCompletedEvent \{[\s\S]*?\n\}/,
  );
  assert(block, 'could not find SyncCompletedEvent in packages/webhooks/src/types.ts');

  const dataBlock = block[0].match(/data: \{([\s\S]*?)\n  \};/);
  assert(dataBlock, 'could not find the data block of SyncCompletedEvent');

  const declared = [...dataBlock[1].matchAll(/^\s{4}(\w+):/gm)]
    .map((m) => m[1])
    .sort();

  const built = buildSyncCompletedPayload({
    subaccountId: 'sub-1',
    connectionId: 'conn-1',
    syncedCount: 3,
  });
  const actual = Object.keys(built.data as Record<string, unknown>).sort();

  assertEquals(
    actual,
    declared,
    'the data object and the SDK type have drifted apart',
  );
});

Deno.test('both wire shapes are present and carry the same values', () => {
  const p = buildSyncCompletedPayload({
    subaccountId: 'sub-1',
    connectionId: 'conn-1',
    syncedCount: 7,
    ts: '2026-08-24T00:00:00.000Z',
  });
  const data = p.data as Record<string, unknown>;

  // Canonical shape: what @orangerails/webhooks constructEvent() reads. It
  // keys on body.type and throws when it is absent, so this is the field
  // whose omission made four of five emitters unparseable by our own SDK.
  assertEquals(p.type, 'sync.completed');
  assertEquals(data.subaccount_id, 'sub-1');
  assertEquals(data.connection_id, 'conn-1');
  assertEquals(data.synced_count, 7);
  assertEquals(data.ts, '2026-08-24T00:00:00.000Z');

  // Legacy flat shape: what hand-rolled receivers written before the SDK
  // read. Both are emitted during the migration window.
  assertEquals(p.event, 'sync.completed');
  assertEquals(p.subaccount_id, data.subaccount_id);
  assertEquals(p.connection_id, data.connection_id);
  assertEquals(p.synced_count, data.synced_count);
  assertEquals(p.ts, data.ts);
});

Deno.test('a zero count is emitted, not dropped', () => {
  // The event-driven sink path pulls no rows itself: the notification exists
  // to tell the integrator to come and call or-sync. Zero is the honest
  // value there. A conditional spread on a falsy number would silently drop
  // it, and an omitted synced_count is exactly the defect that made a
  // receiver reject events while both sides reported success.
  const p = buildSyncCompletedPayload({
    subaccountId: 'sub-1',
    connectionId: 'conn-1',
    syncedCount: 0,
  });
  assertEquals(p.synced_count, 0);
  assertEquals((p.data as Record<string, unknown>).synced_count, 0);
  assert('synced_count' in p, 'synced_count must be present, not omitted');
});

Deno.test('provider is flat-only and omitted when unknown', () => {
  // data is contractually the SDK's declared type. Putting an undeclared
  // field in it would make the published types lie about the payload.
  const withProvider = buildSyncCompletedPayload({
    subaccountId: 'sub-1',
    connectionId: 'conn-1',
    syncedCount: 1,
    provider: 'quiltt',
  });
  assertEquals(withProvider.provider, 'quiltt');
  assertEquals(
    'provider' in (withProvider.data as Record<string, unknown>),
    false,
    'provider must not leak into data',
  );

  const without = buildSyncCompletedPayload({
    subaccountId: 'sub-1',
    connectionId: 'conn-1',
    syncedCount: 1,
  });
  assertEquals(
    'provider' in without,
    false,
    'provider must be absent, not undefined, when the path does not know it',
  );
});

// ── the emitters ──────────────────────────────────────────────────────

/** Every function source file, excluding tests and this shared module. */
function functionSources(): string[] {
  const root = new URL('../', import.meta.url);
  const out: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of Deno.readDirSync(dir)) {
      const child = new URL(
        entry.name + (entry.isDirectory ? '/' : ''),
        dir,
      );
      if (entry.isDirectory) walk(child);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(child.pathname);
      }
    }
  };
  walk(root);
  return out;
}

Deno.test('every sync.completed enqueue goes through the shared builder', () => {
  const offenders: string[] = [];
  let emitters = 0;

  for (const path of functionSources()) {
    const src = Deno.readTextFileSync(path);
    if (!src.includes("event_type:")) continue;

    // Anchor on the webhook_delivery insert, not on the string, so a doc
    // comment mentioning the event name is not mistaken for an emitter.
    const inserts = [
      ...src.matchAll(/event_type:\s*'sync\.completed',([\s\S]{0,600}?)\n\s*\}\);/g),
    ];
    for (const m of inserts) {
      emitters++;
      if (!m[1].includes('payload: buildSyncCompletedPayload(')) {
        offenders.push(path);
      }
    }
  }

  assert(
    emitters >= 5,
    `expected at least the five known emitters, found ${emitters}. ` +
      'If an emitter was legitimately removed, lower this number deliberately ' +
      'rather than letting the scan silently stop covering anything.',
  );
  assertEquals(
    offenders,
    [],
    'these files build a sync.completed payload by hand instead of calling ' +
      'buildSyncCompletedPayload: ' + offenders.join(', '),
  );
});

Deno.test('no hand-built sync.completed literal survives anywhere', () => {
  // The flat shape is legal on the wire but must only ever be produced in
  // one place. A stray `event: 'sync.completed'` in a function source means
  // someone reintroduced a literal.
  const offenders = functionSources().filter((path) => {
    if (path.endsWith('_shared/webhook-events.ts')) return false;
    return /event:\s*'sync\.completed'/.test(Deno.readTextFileSync(path));
  });
  assertEquals(
    offenders,
    [],
    'inline sync.completed payload literals found in: ' + offenders.join(', '),
  );
});
