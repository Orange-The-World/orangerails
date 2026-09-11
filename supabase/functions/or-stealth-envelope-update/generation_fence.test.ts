/**
 * OR-T2457: reproduces the race end to end, against the real production
 * functions (applyEnvelopeReplacement, advanceCursor), not a paraphrase of
 * their logic.
 *
 * The story this proves:
 *   1. A connection is fully synced under an OLD envelope and OLD birthday.
 *   2. The user re-adds the wallet with an EARLIER birthday (a real, common
 *      reason to replace: recovering history the first add missed). This
 *      resets the connection: cursor cleared, coverage cleared, generation
 *      rotated.
 *   3. A sync that was already in flight against the OLD envelope, and had
 *      not yet posted its final cursor write when the reset landed, now
 *      posts that write. It still carries the generation it started with.
 *   4. Before the fix: that write's forward-only guard sees a NULL cursor
 *      and treats it as "anything may write", so the stale height lands and
 *      the next sync resumes from there, never rescanning the gap the reset
 *      opened up. Silent, no error, exactly what OR-T2457 describes.
 *   5. After the fix: the stale write is refused (409) because its
 *      generation does not match the one the reset just minted, the cursor
 *      stays null, and the next sync's computed start height is still the
 *      new birthday.
 *   6. A write carrying the FRESH generation, representing a sync that
 *      genuinely started after the reset, is then shown to proceed
 *      normally: the fence blocks stale writes, not legitimate ones.
 *
 * Honest limit: this covers the TypeScript layer (advanceCursor's atomic
 * UPDATE) only. record_stealth_scan_range()'s equivalent check is SQL
 * running in Postgres and this seat has no shell and no live database
 * connection to run it against, so that half of the fence is reviewed by
 * reading the migration (20260905230000_stealth_connections_scan_generation.sql),
 * not proven by a test run here.
 */

import {
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  applyEnvelopeReplacement,
  isEnvelopeReplacementError,
} from '../or-stealth-connection-create/envelope_replace.ts';
import { advanceCursor, isAdvanceCursorError } from './cursor.ts';

interface FakeConnection {
  id: string;
  scan_generation: string;
  last_block_scanned: number | null;
}

interface FakeScanRange {
  connection_id: string;
  from_height: number;
  to_height: number;
}

interface FakeDb {
  connections: FakeConnection[];
  scan_ranges: FakeScanRange[];
}

/**
 * A single fake client shared by both production modules under test.
 * applyEnvelopeReplacement drives it as a thenable (`await client.from(...)
 * .update(...).eq(...)`, no .select()); advanceCursor drives it as a chained
 * `.select().maybeSingle()`. Both shapes are implemented on the same chain
 * object so the two callers see one consistent, mutating table underneath
 * them, which is what makes this a reproduction of the race rather than two
 * independent unit tests.
 */
// deno-lint-ignore no-explicit-any
function makeSharedClient(db: FakeDb): any {
  function stealthConnectionsChain() {
    let patch: Record<string, unknown> = {};
    const eqFilters: Record<string, unknown> = {};
    let orFilter: string | null = null;
    let wantsSelect = false;
    // deno-lint-ignore no-explicit-any
    const chain: Record<string, any> = {
      update(p: Record<string, unknown>) {
        patch = p;
        return chain;
      },
      select(_cols: string) {
        wantsSelect = true;
        return chain;
      },
      eq(col: string, val: unknown) {
        eqFilters[col] = val;
        return chain;
      },
      or(filter: string) {
        orFilter = filter;
        return chain;
      },
      maybeSingle() {
        const row = db.connections.find((c) => c.id === eqFilters['id']);
        if (!row) return Promise.resolve({ data: null, error: null });
        if (!wantsSelect || Object.keys(patch).length === 0) {
          // The re-read in advanceCursor's no-op path: select(), no update().
          return Promise.resolve({
            data: {
              last_block_scanned: row.last_block_scanned,
              scan_generation: row.scan_generation,
            },
            error: null,
          });
        }
        // advanceCursor's atomic write: apply the same fencing this row
        // would apply for real, as a single conditional operation.
        if (
          eqFilters['scan_generation'] !== undefined &&
          row.scan_generation !== eqFilters['scan_generation']
        ) {
          return Promise.resolve({ data: null, error: null });
        }
        if (orFilter && !evalOr(orFilter, row.last_block_scanned)) {
          return Promise.resolve({ data: null, error: null });
        }
        Object.assign(row, patch);
        return Promise.resolve({
          data: { last_block_scanned: row.last_block_scanned },
          error: null,
        });
      },
      // Thenable path: applyEnvelopeReplacement's connection UPDATE has no
      // .select(), so supabase-js resolves the builder itself.
      then(resolve: (v: { error: null }) => void) {
        const row = db.connections.find((c) => c.id === eqFilters['id']);
        if (row) Object.assign(row, patch);
        resolve({ error: null });
      },
    };
    return chain;
  }

  function stealthScanRangesChain() {
    const eqFilters: Record<string, unknown> = {};
    let deleting = false;
    // deno-lint-ignore no-explicit-any
    const chain: Record<string, any> = {
      delete() {
        deleting = true;
        return chain;
      },
      eq(col: string, val: unknown) {
        eqFilters[col] = val;
        return chain;
      },
      then(resolve: (v: { error: null }) => void) {
        if (deleting) {
          db.scan_ranges = db.scan_ranges.filter(
            (r) => r.connection_id !== eqFilters['connection_id'],
          );
        }
        resolve({ error: null });
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      if (table === 'stealth_connections') return stealthConnectionsChain();
      if (table === 'stealth_scan_ranges') return stealthScanRangesChain();
      throw new Error(`generation_fence.test.ts fake client: unexpected table ${table}`);
    },
  };
}

/** Simulates PostgREST .or() filter-string semantics for this test's two clauses only. */
function evalOr(filter: string, currentValue: number | null): boolean {
  return filter.split(',').some((clause) => {
    const parts = clause.split('.');
    const comparator = parts[1];
    const rhs = parts[2];
    if (comparator === 'is' && rhs === 'null') return currentValue === null;
    if (comparator === 'lt') return currentValue !== null && currentValue < Number(rhs);
    return false;
  });
}

/**
 * Mirrors the documented contract in envelope_replace.ts's module doc comment:
 * scanStartHeight() consults the coverage map first, and whenever a recorded
 * range covers the birthday the cursor arm is never evaluated. This seat could
 * not resolve the exact import path for the production resume-height helper
 * from this session (no shell available to locate it, and the local repo
 * clone reachable here is not the one carrying this code), so this
 * reimplements the documented formula rather than importing it. If that
 * formula ever changes, this helper needs to change with it.
 */
function nextSyncStartHeight(
  birthdayHeight: number,
  lastBlockScanned: number | null,
  coverage: FakeScanRange[],
): number {
  const coveredAtBirthday = coverage.some(
    (r) => r.from_height <= birthdayHeight && birthdayHeight <= r.to_height,
  );
  if (coveredAtBirthday) return birthdayHeight;
  const cursorArm = lastBlockScanned === null ? birthdayHeight : lastBlockScanned + 1;
  return Math.max(birthdayHeight, cursorArm);
}

Deno.test(
  'OR-T2457: a stale write from before a reset cannot resurrect the cursor and defeat the rescan',
  async () => {
    const OLD_GENERATION = 'gen-before-reset';
    const OLD_BIRTHDAY = 800_000;
    const NEW_BIRTHDAY = 400_000; // earlier: the user is recovering older history
    const STALE_HEIGHT = 900_000; // what the in-flight old-envelope sync is about to post

    const db: FakeDb = {
      connections: [{
        id: 'conn-1',
        scan_generation: OLD_GENERATION,
        last_block_scanned: 850_000, // fully synced under the old envelope
      }],
      scan_ranges: [{ connection_id: 'conn-1', from_height: OLD_BIRTHDAY, to_height: 850_000 }],
    };
    const client = makeSharedClient(db);

    // 1. The real reset: the user re-adds the wallet with an earlier birthday.
    const replacement = await applyEnvelopeReplacement(client, 'conn-1', {
      sealed_envelope: { fake: 'new-envelope' },
      wallet_birthday_plaintext: '2020-01-01',
    });
    assertEquals(isEnvelopeReplacementError(replacement), false, JSON.stringify(replacement));
    assertEquals(db.scan_ranges.length, 0, 'coverage must be cleared by the reset');
    assertEquals(db.connections[0].last_block_scanned, null, 'cursor must be cleared by the reset');
    const freshGeneration = db.connections[0].scan_generation;
    assertNotEquals(freshGeneration, OLD_GENERATION, 'the reset must rotate the generation');

    // 2. The stale write: a sync of the OLD envelope, mid-flight when the
    //    reset landed, posts its final cursor write still carrying OLD_GENERATION.
    const staleWrite = await advanceCursor(
      client,
      'platform-1',
      'conn-1',
      STALE_HEIGHT,
      OLD_GENERATION,
    );
    assertEquals(isAdvanceCursorError(staleWrite), true, JSON.stringify(staleWrite));
    if (isAdvanceCursorError(staleWrite)) {
      assertEquals(staleWrite.status, 409);
    }

    // 3. The defect this closes: without the fence, that write would have put
    //    the pre-reset height back, and the next sync would resume from
    //    there, never rescanning NEW_BIRTHDAY..OLD_BIRTHDAY again, silently.
    assertEquals(
      db.connections[0].last_block_scanned,
      null,
      'the stale write must not move the cursor at all',
    );
    const startHeight = nextSyncStartHeight(
      NEW_BIRTHDAY,
      db.connections[0].last_block_scanned,
      db.scan_ranges.filter((r) => r.connection_id === 'conn-1'),
    );
    assertEquals(
      startHeight,
      NEW_BIRTHDAY,
      'the next sync must start at the new birthday, not a resurrected stale height',
    );

    // 4. The fence is a fence, not a lockout: a write carrying the fresh
    //    generation (a sync that genuinely started after the reset) proceeds.
    const freshWrite = await advanceCursor(
      client,
      'platform-1',
      'conn-1',
      NEW_BIRTHDAY + 1000,
      freshGeneration,
    );
    assertEquals(isAdvanceCursorError(freshWrite), false, JSON.stringify(freshWrite));
    assertEquals(db.connections[0].last_block_scanned, NEW_BIRTHDAY + 1000);
  },
);
