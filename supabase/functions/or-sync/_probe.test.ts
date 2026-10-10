// Tests for the anonymous GET probe route (DEV-0126). See _connection-result.ts
// for buildProbeBody and index.ts for the call site (Deno.serve() at import
// time keeps handler tests out of index.test.ts; same extraction pattern as
// the rest of this directory).

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildProbeBody } from './_connection-result.ts';

Deno.test('buildProbeBody: function name is or-sync', () => {
  const body = buildProbeBody(null);
  assertEquals(body.function, 'or-sync');
});

Deno.test('buildProbeBody: build passes through the sha it is given', () => {
  assertEquals(buildProbeBody('abc123').build, 'abc123');
});

Deno.test('buildProbeBody: build is null when no sha is available', () => {
  assertEquals(buildProbeBody(null).build, null);
});

Deno.test('buildProbeBody: connection_result_fields is derived from readSyncCompleteness, not hardcoded', () => {
  // A forced-partial sample result (non-empty denied_sources) must surface
  // BOTH keys. A hardcoded list would pass this test too, which is exactly
  // why the acceptance criterion on the ticket also requires reading the
  // live deployed response, not just a green test.
  const fields = buildProbeBody(null).connection_result_fields;
  assertEquals(fields.includes('status'), true);
  assertEquals(fields.includes('denied_sources'), true);
});
