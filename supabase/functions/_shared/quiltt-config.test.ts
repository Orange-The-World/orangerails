/**
 * Deno tests for resolveSinkFormatForPlatform's 'none' sentinel handling.
 *
 * Run with:
 *   deno test supabase/functions/_shared/quiltt-config.test.ts
 *
 * OR-T1249: the DBA is about to backfill platforms.sink_format with the
 * literal string 'none' as an explicit no-sink marker (OR-T1208). Before
 * that backfill writes a single row, this pins that the resolver maps it
 * to null rather than handing the literal string 'none' back to or-sync,
 * which would treat it as an unknown sink format and 400.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveSinkFormatForPlatform } from './quiltt-config.ts';

// Minimal Supabase-builder-shaped stub, same pattern as
// or-connection-confirm/index.test.ts: .from().select().eq().maybeSingle()
// resolves to a fixed { data, error } shape.
// deno-lint-ignore no-explicit-any
function makeMockClient(sinkFormat: string | null): any {
  return {
    from(_table: string) {
      const chain = {
        select(_cols: string) {
          return chain;
        },
        eq(_col: string, _val: unknown) {
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({
            data: { sink_format: sinkFormat },
            error: null,
          });
        },
      };
      return chain;
    },
  };
}

Deno.test("resolveSinkFormatForPlatform: stored 'none' resolves to null, not the string", async () => {
  const client = makeMockClient('none');
  const got = await resolveSinkFormatForPlatform(client, 'platform-id', 'bitbooks-v2');
  assertEquals(got, null);
});

Deno.test("resolveSinkFormatForPlatform: 'none' wins even when body.format would name a real sink", async () => {
  // A caller sending body.format alongside a platform row explicitly opted
  // into no-sink must not be able to force sink mode back on: server-side
  // resolution wins over body.format for a configured row (existing rule),
  // and the sentinel is a configured row.
  const client = makeMockClient('none');
  const got = await resolveSinkFormatForPlatform(client, 'platform-id', 'orangeway-me');
  assertEquals(got, null);
});

Deno.test('resolveSinkFormatForPlatform: NULL column still falls back to body.format (unchanged)', async () => {
  const client = makeMockClient(null);
  const got = await resolveSinkFormatForPlatform(client, 'platform-id', 'bitbooks-v2');
  assertEquals(got, 'bitbooks-v2');
});

Deno.test('resolveSinkFormatForPlatform: NULL column and no body.format resolves to null (unchanged)', async () => {
  const client = makeMockClient(null);
  const got = await resolveSinkFormatForPlatform(client, 'platform-id', null);
  assertEquals(got, null);
});

Deno.test('resolveSinkFormatForPlatform: a real registered format still wins over body.format (unchanged)', async () => {
  const client = makeMockClient('bitbooks-v2');
  const got = await resolveSinkFormatForPlatform(client, 'platform-id', 'orangeway-me');
  assertEquals(got, 'bitbooks-v2');
});

Deno.test("resolveSinkFormatForPlatform: the resolved value for 'none' can never pass or-sync's sink-mode check", async () => {
  // Pins the acceptance criterion directly against or-sync's own guard
  // expression (index.ts:286): `typeof format === 'string' && format.length > 0`.
  // If this test is ever red, so is production sink-mode entry for a
  // platform carrying the sentinel.
  const client = makeMockClient('none');
  const format = await resolveSinkFormatForPlatform(client, 'platform-id', null);
  const sinkMode = typeof format === 'string' && format.length > 0;
  assertEquals(sinkMode, false);
});
