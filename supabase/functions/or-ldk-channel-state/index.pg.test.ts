/**
 * Orange Rails, LDK connector — LIVE EXECUTION test for OR-T1721.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *   deno test --no-check --allow-all supabase/functions/or-ldk-channel-state/index.pg.test.ts
 *
 * WHY THIS FILE EXISTS, AND WHY index.test.ts WAS NOT ENOUGH.
 *
 * index.test.ts pins the live schema as DATA and checks the SQL string
 * against it: real proof the referenced columns and the conflict target
 * exist, but a string check cannot see anything Postgres itself would
 * reject at parse or plan time, and it cannot show the compare-and-set
 * actually behaves as the header comment on index.ts describes.
 *
 * This file instead opens a real Postgres connection, applies the exact
 * shipped migration (20260711120000_channel_state.sql, see
 * .github/workflows/ci.yml's "Apply channel_state schema" step, which runs
 * against a disposable postgres:16 service container for this job only),
 * and executes UPSERT_CHANNEL_STATE_SQL itself. If TEST_DATABASE_URL is
 * unset, every case here reports ignored, never a silent pass: absence of
 * a database must read as "not run", not as "ran and passed".
 *
 * The exported SQL binds named placeholders (:user_id, :bidx, ...); the
 * handler that will bind them for real is still a TODO (index.ts). This
 * test binds them positionally in the same order that TODO comment
 * documents (user_id, bidx, new_id, seal_version, sealed_iv, sealed_ct),
 * which is a test-only concern and changes nothing about the shipped SQL.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Client } from 'https://deno.land/x/postgres@v0.19.3/mod.ts';
import { UPSERT_CHANNEL_STATE_SQL } from './index.ts';

const DATABASE_URL = Deno.env.get('TEST_DATABASE_URL') ?? '';
const HAS_DB = DATABASE_URL.length > 0;

const BIND_ORDER = ['user_id', 'bidx', 'new_id', 'seal_version', 'sealed_iv', 'sealed_ct'];

function toPositional(sql: string): string {
  let out = sql;
  BIND_ORDER.forEach((name, i) => {
    out = out.replaceAll(`:${name}`, `$${i + 1}`);
  });
  return out;
}

const POSITIONAL_SQL = toPositional(UPSERT_CHANNEL_STATE_SQL);
const USER_A = '11111111-1111-1111-1111-111111111111';
const BIDX_A = 'a'.repeat(64);
const IV = new Uint8Array(12);
const CT = new Uint8Array(17).fill(1);

async function withClient(fn: (c: Client) => Promise<void>) {
  const client = new Client(DATABASE_URL);
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

Deno.test({
  name: 'UPSERT_CHANNEL_STATE_SQL executes against the real channel_state schema and inserts',
  ignore: !HAS_DB,
  fn: async () => {
    await withClient(async (client) => {
      await client.queryArray('insert into auth.users (id) values ($1) on conflict do nothing', [USER_A]);
      await client.queryArray('delete from public.channel_state where user_id = $1', [USER_A]);

      const res = await client.queryArray<[bigint]>(POSITIONAL_SQL, [USER_A, BIDX_A, 1n, 1, IV, CT]);
      assertEquals(res.rows.length, 1, 'a fresh insert must RETURNING the row it just wrote');
      assertEquals(res.rows[0][0], 1n);
    });
  },
});

Deno.test({
  name: 'UPSERT_CHANNEL_STATE_SQL rejects a stale update_id via the ON CONFLICT WHERE clause',
  ignore: !HAS_DB,
  fn: async () => {
    await withClient(async (client) => {
      await client.queryArray('insert into auth.users (id) values ($1) on conflict do nothing', [USER_A]);
      await client.queryArray('delete from public.channel_state where user_id = $1', [USER_A]);

      // Seed at update_id 5.
      await client.queryArray(POSITIONAL_SQL, [USER_A, BIDX_A, 5n, 1, IV, CT]);

      // A lower update_id must not return a row: this is the exact
      // compare-and-set the header comment on UPSERT_CHANNEL_STATE_SQL
      // describes (two concurrent restores cannot both pass).
      const stale = await client.queryArray(POSITIONAL_SQL, [USER_A, BIDX_A, 3n, 1, IV, CT]);
      assertEquals(stale.rows.length, 0, 'a lower update_id must not return a row (REJECTED_STALE path)');

      const stored = await client.queryObject<{ update_id: bigint }>(
        'select update_id from public.channel_state where user_id = $1 and outpoint_bidx = $2',
        [USER_A, BIDX_A],
      );
      assertEquals(stored.rows[0].update_id, 5n, 'the watermark must still read the last accepted update_id');
    });
  },
});
