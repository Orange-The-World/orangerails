/**
 * OR-T2457 step 7: reproduces the same race as
 * ../or-stealth-envelope-update/generation_fence.test.ts, against the real
 * production reset function (applyEnvelopeReplacement) and the real fence
 * this endpoint now applies (checkScanGenerationFence), not a paraphrase of
 * either.
 *
 * or-stealth-transactions-store writes the same stealth_connections.
 * last_block_scanned column or-stealth-envelope-update's advanceCursor
 * already fenced with scan_generation. This proves the same story for the
 * sibling endpoint:
 *   1. A connection is fully synced under an OLD envelope and OLD generation.
 *   2. The user replaces the wallet with an earlier birthday. This resets the
 *      connection: cursor cleared, coverage cleared, generation rotated.
 *   3. A sync that was already in flight against the OLD envelope, and had
 *      not yet posted its upload call when the reset landed, now posts it.
 *      It still carries the generation it started with.
 *   4. checkScanGenerationFence refuses that write (409): unlike
 *      advanceCursor's atomic UPDATE guard, this endpoint reads the
 *      connection row once (a few lines above the call site in index.ts) and
 *      checks it synchronously, but the value being compared is the SAME
 *      scan_generation column the reset just rotated, so the outcome is
 *      identical: refused, not silently accepted.
 *   5. A write carrying the FRESH generation, representing a sync that
 *      genuinely started after the reset, is shown to pass the fence.
 *
 * Honest limit: this test proves the fence FUNCTION refuses a stale token.
 * It does not spin up the Deno.serve HTTP handler (no test harness for that
 * exists in this endpoint, matching or-stealth-envelope-update's own note
 * that it has no shell to run one), so the wiring at the call site in
 * index.ts (fence checked right after the existing ownership match, before
 * the transaction insert) is reviewed by reading the diff, the same way the
 * sibling's SQL-side fence (record_stealth_scan_range) is reviewed by
 * reading the migration rather than proven by a test run here.
 */

import {
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  applyEnvelopeReplacement,
  isEnvelopeReplacementError,
} from '../or-stealth-connection-create/envelope_replace.ts';
import { checkScanGenerationFence } from './index.ts';

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
 * Only applyEnvelopeReplacement needs a fake Supabase client here;
 * checkScanGenerationFence takes plain values and does no I/O of its own.
 * This is a trimmed copy of the connections-chain half of
 * ../or-stealth-envelope-update/generation_fence.test.ts's makeSharedClient:
 * the advanceCursor-specific select/or/maybeSingle machinery is not needed,
 * because this endpoint's fence is not itself an atomic DB call, it is a
 * synchronous check against a value already read a few lines earlier.
 */
// deno-lint-ignore no-explicit-any
function makeResetOnlyClient(db: FakeDb): any {
  function stealthConnectionsChain() {
    let patch: Record<string, unknown> = {};
    const eqFilters: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const chain: Record<string, any> = {
      update(p: Record<string, unknown>) {
        patch = p;
        return chain;
      },
      eq(col: string, val: unknown) {
        eqFilters[col] = val;
        return chain;
      },
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

Deno.test(
  'OR-T2457 step 7: a stale write from before a reset is refused, a fresh one is not',
  async () => {
    const OLD_GENERATION = 'gen-before-reset';

    const db: FakeDb = {
      connections: [{
        id: 'conn-1',
        scan_generation: OLD_GENERATION,
        last_block_scanned: 850_000, // fully synced under the old envelope
      }],
      scan_ranges: [{ connection_id: 'conn-1', from_height: 800_000, to_height: 850_000 }],
    };
    const client = makeResetOnlyClient(db);

    // 1. The real reset: the user re-adds the wallet with an earlier birthday.
    const replacement = await applyEnvelopeReplacement(client, 'conn-1', {
      sealed_envelope: { fake: 'new-envelope' },
      wallet_birthday_plaintext: '2020-01-01',
    });
    assertEquals(isEnvelopeReplacementError(replacement), false, JSON.stringify(replacement));
    const freshGeneration = db.connections[0].scan_generation;
    assertNotEquals(freshGeneration, OLD_GENERATION, 'the reset must rotate the generation');

    // 2. The stale write: an upload call from a sync of the OLD envelope,
    //    mid-flight when the reset landed, still carries OLD_GENERATION. In
    //    the real handler ownerRow.scan_generation is read fresh from the
    //    row a few lines above the call site, so by the time this check
    //    runs it already holds the POST-reset value (freshGeneration),
    //    exactly as it does here.
    const staleCheck = checkScanGenerationFence(freshGeneration, OLD_GENERATION);
    assertEquals(staleCheck.ok, false, JSON.stringify(staleCheck));
    assertEquals(staleCheck.status, 409);
    assertEquals(
      staleCheck.error,
      'Connection was reset since this sync began; stale write refused',
    );

    // 3. The fence is a fence, not a lockout: a write carrying the fresh
    //    generation (a sync that genuinely started after the reset) passes.
    const freshCheck = checkScanGenerationFence(freshGeneration, freshGeneration);
    assertEquals(freshCheck.ok, true, JSON.stringify(freshCheck));
  },
);
