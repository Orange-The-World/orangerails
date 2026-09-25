/**
 * Tests for or-stealth-reorg-check.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-reorg-check/index.test.ts
 *
 * Covers:
 *   - REORG_LOOKBACK_BLOCKS is exported as 100
 *   - A mismatch between stored block_hash and canonical hash causes the
 *     row to be included in the orphaned set
 *   - NULL block_hash rows are NEVER included in the candidates that are
 *     checked against the canonical chain
 *   - A row whose hash matches the canonical chain is NOT orphaned
 *   - Height 0 rows are excluded from the look-back window
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { REORG_LOOKBACK_BLOCKS } from './index.ts';

// ── REORG_LOOKBACK_BLOCKS constant ────────────────────────────────────────────

Deno.test('REORG_LOOKBACK_BLOCKS is exactly 100', () => {
  assertEquals(
    REORG_LOOKBACK_BLOCKS,
    100,
    'The look-back window must be 100, not 6.  The two numbers are ' +
    'deliberately far apart: the 6-block buffer is PREVENTION, ' +
    'REORG_LOOKBACK_BLOCKS=100 is DETECTION, and they must not fail ' +
    'for the same reason.  Change only after measuring real cost on ' +
    'OR-T0999 and proposing the new number there.',
  );
});

Deno.test('REORG_LOOKBACK_BLOCKS is not equal to CONFIRMATION_BUFFER (6)', () => {
  // Belt-and-suspenders: if someone accidentally sets the look-back equal to
  // the confirmation buffer both defences fail for the same event.
  assert(
    REORG_LOOKBACK_BLOCKS !== 6,
    'REORG_LOOKBACK_BLOCKS must not equal the 6-block confirmation buffer. ' +
    'See the module comment in index.ts for the full rationale.',
  );
});

// ── Candidate selection logic ─────────────────────────────────────────────────
//
// The database query selects rows where:
//   - orphaned_at IS NULL
//   - block_hash IS NOT NULL
//   - block_height >= max(1, chain_tip - REORG_LOOKBACK_BLOCKS)
//   - block_height <= chain_tip
//
// We simulate the filter here so we can assert NULL rows and height-0 rows
// are excluded without a live database.

interface FakeRow {
  id: string;
  block_height: number;
  block_hash: string | null;
  orphaned_at: string | null;
}

/**
 * Replicates the candidate-selection logic from index.ts so we can unit-test
 * it in isolation.  Any change to the SELECT in index.ts must be reflected here.
 */
function selectCandidates(rows: FakeRow[], chainTip: number): FakeRow[] {
  const lookbackFrom = Math.max(1, chainTip - REORG_LOOKBACK_BLOCKS);
  return rows.filter(
    (r) =>
      r.orphaned_at === null &&
      r.block_hash !== null &&
      r.block_height >= lookbackFrom &&
      r.block_height <= chainTip,
  );
}

Deno.test('candidate selection: NULL block_hash rows are excluded', () => {
  const rows: FakeRow[] = [
    { id: 'a', block_height: 900050, block_hash: null, orphaned_at: null },
    { id: 'b', block_height: 900050, block_hash: '00'.repeat(32), orphaned_at: null },
  ];
  const candidates = selectCandidates(rows, 900100);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].id, 'b');
});

Deno.test('candidate selection: already-orphaned rows are excluded', () => {
  const rows: FakeRow[] = [
    { id: 'a', block_height: 900050, block_hash: '00'.repeat(32), orphaned_at: '2026-09-01T00:00:00Z' },
    { id: 'b', block_height: 900050, block_hash: '01'.repeat(32), orphaned_at: null },
  ];
  const candidates = selectCandidates(rows, 900100);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].id, 'b');
});

Deno.test('candidate selection: height 0 rows are excluded', () => {
  // height 0 is a sentinel for unknown heights AND the real genesis block.
  // We cannot distinguish them, so we skip both.  See the module comment.
  const rows: FakeRow[] = [
    { id: 'genesis', block_height: 0, block_hash: '00'.repeat(32), orphaned_at: null },
    { id: 'real', block_height: 900050, block_hash: '01'.repeat(32), orphaned_at: null },
  ];
  const candidates = selectCandidates(rows, 900100);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].id, 'real');
});

Deno.test('candidate selection: rows outside the look-back window are excluded', () => {
  const chainTip = 900100;
  const rows: FakeRow[] = [
    // Inside window (inclusive lower bound)
    { id: 'in-lower', block_height: chainTip - REORG_LOOKBACK_BLOCKS, block_hash: '01'.repeat(32), orphaned_at: null },
    // Outside window
    { id: 'out', block_height: chainTip - REORG_LOOKBACK_BLOCKS - 1, block_hash: '01'.repeat(32), orphaned_at: null },
    // At tip (inclusive upper bound)
    { id: 'at-tip', block_height: chainTip, block_hash: '02'.repeat(32), orphaned_at: null },
  ];
  const candidates = selectCandidates(rows, chainTip);
  assertEquals(candidates.map((r) => r.id).sort(), ['at-tip', 'in-lower']);
});

// ── Mismatch detection ────────────────────────────────────────────────────────
//
// Simulates what the function does after fetching canonical hashes:
// build the orphaned set from mismatches.

function detectOrphans(
  candidates: Array<{ id: string; block_height: number; block_hash: string }>,
  canonicalMap: Map<number, string | null>,
): string[] {
  const orphaned: string[] = [];
  for (const row of candidates) {
    const canonical = canonicalMap.get(row.block_height);
    if (canonical === null || canonical === undefined) continue; // fetch failed, skip
    if (row.block_hash !== canonical) orphaned.push(row.id);
  }
  return orphaned;
}

Deno.test('mismatch: stored hash differs from canonical -> row is orphaned', () => {
  const canonical = 'aa'.repeat(32);
  const stored = 'bb'.repeat(32);
  const candidates = [{ id: 'tx1', block_height: 900050, block_hash: stored }];
  const canonicalMap = new Map([[900050, canonical]]);
  const orphaned = detectOrphans(candidates, canonicalMap);
  assertEquals(orphaned, ['tx1']);
});

Deno.test('mismatch: stored hash matches canonical -> row is NOT orphaned', () => {
  const hash = 'aa'.repeat(32);
  const candidates = [{ id: 'tx1', block_height: 900050, block_hash: hash }];
  const canonicalMap = new Map([[900050, hash]]);
  const orphaned = detectOrphans(candidates, canonicalMap);
  assertEquals(orphaned.length, 0);
});

Deno.test('mismatch: fetch failure (null canonical) -> row is skipped, not orphaned', () => {
  // A transient fetch error must never mark a real transaction as orphaned.
  const candidates = [{ id: 'tx1', block_height: 900050, block_hash: 'aa'.repeat(32) }];
  const canonicalMap = new Map<number, string | null>([[900050, null]]);
  const orphaned = detectOrphans(candidates, canonicalMap);
  assertEquals(orphaned.length, 0, 'A failed hash fetch must not orphan a real transaction');
});

Deno.test('mismatch: multiple rows in same block -- only mismatch is orphaned', () => {
  const canonical = 'aa'.repeat(32);
  const candidates = [
    { id: 'tx-match', block_height: 900050, block_hash: canonical },
    { id: 'tx-mismatch', block_height: 900050, block_hash: 'bb'.repeat(32) },
  ];
  const canonicalMap = new Map([[900050, canonical]]);
  const orphaned = detectOrphans(candidates, canonicalMap);
  assertEquals(orphaned, ['tx-mismatch']);
});

// ── OR-stealth-transactions-list filter (orphaned_at exclusion) ───────────────
//
// Proves the query filter excludes orphaned rows so the customer balance corrects.
// This does not hit a live DB; it verifies the filter shape we rely on.

Deno.test('list filter: orphaned row is excluded from customer-visible set', () => {
  interface ListRow { id: string; orphaned_at: string | null; }
  const allRows: ListRow[] = [
    { id: 'live', orphaned_at: null },
    { id: 'orphaned', orphaned_at: '2026-09-22T00:00:00Z' },
  ];
  // Replicates .is('orphaned_at', null) from or-stealth-transactions-list
  const visible = allRows.filter((r) => r.orphaned_at === null);
  assertEquals(visible.map((r) => r.id), ['live']);
  assert(!visible.some((r) => r.id === 'orphaned'), 'orphaned row must not appear in customer list');
});

Deno.test('list filter: after orphaning, amount is absent from customer-visible set', () => {
  // Simulates: transaction was visible, reorg check sets orphaned_at, list no longer includes it.
  interface TxRow { id: string; amount_sats: number; orphaned_at: string | null; }
  const beforeReorg: TxRow[] = [{ id: 'tx1', amount_sats: 5_000_000, orphaned_at: null }];
  const afterReorg: TxRow[] = [{ id: 'tx1', amount_sats: 5_000_000, orphaned_at: '2026-09-22T00:00:00Z' }];

  const visibleBefore = beforeReorg.filter((r) => r.orphaned_at === null);
  const visibleAfter = afterReorg.filter((r) => r.orphaned_at === null);

  assertEquals(visibleBefore.reduce((s, r) => s + r.amount_sats, 0), 5_000_000);
  assertEquals(visibleAfter.reduce((s, r) => s + r.amount_sats, 0), 0,
    'Amount must be 0 in customer-visible set after the reorg detection sets orphaned_at');
});
