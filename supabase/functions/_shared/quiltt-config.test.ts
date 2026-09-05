/**
 * Tests for resolveSinkFormatForPlatform's 'none' sink sentinel handling
 * (OR-T1249, sentinel introduced on OR-T1208).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/quiltt-config.test.ts
 *
 * WHAT IS UNDER TEST, and why it is shaped this way.
 *
 * 'none' means a platform was explicitly configured to have no sink, as
 * opposed to NULL, which means the platform was simply never configured.
 * The two must NOT behave the same: NULL falls back to body.format so a
 * legacy caller keeps working during the multi-tenant transition, but
 * 'none' must return null outright and never reach that fallback, or a
 * platform that just opted out of sink delivery could still be re-armed
 * by whatever a caller's request body happens to say.
 *
 * These tests exercise the real resolveSinkFormatForPlatform against a
 * small hand-rolled mock of the one Supabase call it makes
 * (.from('platforms').select('sink_format').eq('id', ...).maybeSingle()),
 * not a re-statement of its logic, so a regression in the function itself
 * fails here.
 */

import {
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveSinkFormatForPlatform } from './quiltt-config.ts';

// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * A minimal mock of the one chain resolveSinkFormatForPlatform issues:
 *   .from('platforms').select('sink_format').eq('id', id).maybeSingle()
 *
 * `row` is what maybeSingle() resolves data to (null models "no such
 * platform row"). `errMessage`, when set, models a Postgres error instead.
 */
function makeClient(
  row: { sink_format: string | null } | null,
  errMessage?: string,
): AnyClient {
  const chain = {
    from(table: string) {
      assertEquals(table, 'platforms');
      return chain;
    },
    select(cols: string) {
      assertEquals(cols, 'sink_format');
      return chain;
    },
    eq(col: string, _value: string) {
      assertEquals(col, 'id');
      return chain;
    },
    async maybeSingle() {
      if (errMessage) {
        return { data: null, error: { message: errMessage } };
      }
      return { data: row, error: null };
    },
  };
  return chain;
}

Deno.test('OR-T1249: sink_format = none resolves to null, and does NOT fall through to body.format', async () => {
  const client = makeClient({ sink_format: 'none' });
  const result = await resolveSinkFormatForPlatform(client, 'platform-1', 'bitbooks-v2');
  assertEquals(
    result,
    null,
    'a platform explicitly opted out of sink delivery must not be re-armed by body.format',
  );
});

Deno.test('OR-T1249: sink_format = none resolves to null with no fallback offered either', async () => {
  const client = makeClient({ sink_format: 'none' });
  const result = await resolveSinkFormatForPlatform(client, 'platform-1');
  assertEquals(result, null);
});

Deno.test('OR-T1249: a real registered sink_format still resolves to itself, unaffected by the sentinel', async () => {
  const client = makeClient({ sink_format: 'bitbooks-v2' });
  const result = await resolveSinkFormatForPlatform(client, 'platform-1', 'orangeway-me');
  assertEquals(result, 'bitbooks-v2', 'the platform value must still win over body.format');
});

Deno.test('OR-T1249: NULL sink_format (never configured) still falls back to body.format', async () => {
  const client = makeClient({ sink_format: null });
  const result = await resolveSinkFormatForPlatform(client, 'platform-1', 'bitbooks-v2');
  assertEquals(
    result,
    'bitbooks-v2',
    'NULL is "never configured", not "explicitly no sink", so the legacy fallback must still apply',
  );
});

Deno.test('OR-T1249: NULL sink_format with no fallback and no row resolve to null', async () => {
  const client = makeClient(null);
  const result = await resolveSinkFormatForPlatform(client, 'platform-1');
  assertEquals(result, null);
});

Deno.test('OR-T1249: a platforms lookup error still throws, unchanged by the sentinel handling', async () => {
  const client = makeClient(null, 'connection reset');
  await assertRejects(
    () => resolveSinkFormatForPlatform(client, 'platform-1', 'bitbooks-v2'),
    Error,
    'platforms.sink_format lookup failed: connection reset',
  );
});
