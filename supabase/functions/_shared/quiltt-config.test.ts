/**
 * Deno tests for resolveSinkFormatForPlatform (OR-T1157, out of the OR-T0991
 * ruling).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/quiltt-config.test.ts
 *
 * Pins the four-case resolution contract directly, against a fake Supabase
 * client, with no network and no Deno.serve involved:
 *   1. platforms.sink_format IS NULL            -> body.format passes through unchanged.
 *   2. populated AND equal to body.format       -> no-op.
 *   3. populated AND different from body.format -> reported as a mismatch, NOT thrown.
 *   4. body.format absent, sink_format populated -> resolves to sink_format.
 *
 * What this function does NOT decide: whether a mismatch is refused,
 * rewritten, or logged. That is supabase/functions/or-sync/index.ts's call,
 * gated by OR_SYNC_SINK_FORMAT_ENFORCE, and is pinned separately in
 * or-sync/index.test.ts because it cannot be exercised from here.
 */

import { assertEquals, assert, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveSinkFormatForPlatform } from './quiltt-config.ts';
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';

/** A minimal fake of the one query chain resolveSinkFormatForPlatform makes. */
function fakePlatformsClient(
  result: { sink_format: string | null } | null,
  errorMessage?: string,
  // deno-lint-ignore no-explicit-any
): any {
  return {
    from: (table: string) => {
      assertEquals(table, 'platforms');
      return {
        select: (cols: string) => {
          assertEquals(cols, 'sink_format');
          return {
            eq: (col: string, _val: string) => {
              assertEquals(col, 'id');
              return {
                maybeSingle: () =>
                  Promise.resolve(
                    errorMessage
                      ? { data: null, error: { message: errorMessage } }
                      : { data: result, error: null },
                  ),
              };
            },
          };
        },
      };
    },
  };
}

// ── Case 1: sink_format IS NULL ───────────────────────────────────────────

Deno.test('resolveSinkFormatForPlatform: sink_format NULL passes body.format through unchanged', async () => {
  const client = fakePlatformsClient({ sink_format: null });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', 'bitbooks-v2');
  assertEquals(r.format, 'bitbooks-v2');
  assertEquals(r.mismatch, false);
  assertEquals(r.serverFormat, null);
  assertEquals(r.bodyFormat, 'bitbooks-v2');
});

Deno.test('resolveSinkFormatForPlatform: sink_format NULL and body.format absent resolves to null (encrypted-payload mode)', async () => {
  const client = fakePlatformsClient({ sink_format: null });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', null);
  assertEquals(r.format, null);
  assertEquals(r.mismatch, false);
});

// ── Case 2: populated and equal to body.format ────────────────────────────

Deno.test('resolveSinkFormatForPlatform: populated and equal to body.format is a no-op', async () => {
  const client = fakePlatformsClient({ sink_format: 'bitbooks-v2' });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', 'bitbooks-v2');
  assertEquals(r.format, 'bitbooks-v2');
  assertEquals(r.mismatch, false, 'agreement must never be reported as a mismatch');
  assertEquals(r.serverFormat, 'bitbooks-v2');
  assertEquals(r.bodyFormat, 'bitbooks-v2');
});

// ── Case 3: populated and different from body.format ──────────────────────

Deno.test('resolveSinkFormatForPlatform: populated and different from body.format is reported as a mismatch, not thrown', async () => {
  const client = fakePlatformsClient({ sink_format: 'orangeway-me' });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', 'orangeway-books');
  assertEquals(r.mismatch, true);
  assertEquals(r.serverFormat, 'orangeway-me', 'server format must be reported for the caller to act on');
  assertEquals(r.bodyFormat, 'orangeway-books', 'body format must be reported for the caller to act on');
  assertEquals(r.format, 'orangeway-me', 'resolver still recommends the platform-configured sink on a mismatch');
});

// ── Case 4: body.format absent, sink_format populated ──────────────────────

Deno.test('resolveSinkFormatForPlatform: body.format absent with sink_format populated resolves to sink_format', async () => {
  const client = fakePlatformsClient({ sink_format: 'bitbooks-v2' });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', null);
  assertEquals(r.format, 'bitbooks-v2');
  assertEquals(r.mismatch, false, 'nothing to conflict with when body.format was never sent');
  assertEquals(r.serverFormat, 'bitbooks-v2');
  assertEquals(r.bodyFormat, null);
});

Deno.test('resolveSinkFormatForPlatform: body.format undefined behaves the same as null', async () => {
  const client = fakePlatformsClient({ sink_format: 'bitbooks-v2' });
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', undefined);
  assertEquals(r.format, 'bitbooks-v2');
  assertEquals(r.mismatch, false);
});

// ── Lookup failure ──────────────────────────────────────────────────────────

Deno.test('resolveSinkFormatForPlatform: a platforms lookup error throws, it is not swallowed', async () => {
  const client = fakePlatformsClient(null, 'connection reset');
  await assertRejects(
    () => resolveSinkFormatForPlatform(client as SupabaseClient, 'p1', 'bitbooks-v2'),
    Error,
    'platforms.sink_format lookup failed',
  );
});

Deno.test('resolveSinkFormatForPlatform: no matching platform row (data null, no sink_format) behaves like case 1', async () => {
  const client = fakePlatformsClient(null);
  const r = await resolveSinkFormatForPlatform(client as SupabaseClient, 'missing-platform', 'bitbooks-v2');
  assertEquals(r.format, 'bitbooks-v2');
  assertEquals(r.mismatch, false);
  assertEquals(r.serverFormat, null);
});
