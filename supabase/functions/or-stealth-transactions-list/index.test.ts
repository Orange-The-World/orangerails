/**
 * Tests for or-stealth-transactions-list pagination (DL-1174).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-stealth-transactions-list/index.test.ts
 *
 * What this guards, and why it is shaped the way it is:
 *
 * block_height is NOT unique on stealth_transactions. The only uniqueness is
 * (connection_id, txid_blind_index_hex), and a single block can hold many of
 * one wallet's transactions. An ordering of block_height alone is a partial
 * order, so a `block_height < before_block` cursor drops every remaining row
 * of a block whenever a page boundary lands inside it, and the unstable tie
 * lets one row come back on two different pages.
 *
 * A test that hardcoded its own copy of the ordering and its own copy of the
 * cursor predicate would keep passing after production changed either one, so
 * it would guard nothing. This file instead drives the REAL exports:
 *
 *   - the comparator is built from PAGE_ORDER, the same array production feeds
 *     to .order();
 *   - the page predicate is produced by cursorOrExpression, the same string
 *     production hands to .or(), parsed and evaluated here by a small
 *     PostgREST expression evaluator;
 *   - the cursor is produced by nextCursorFrom, exactly as the handler builds
 *     the next_cursor it returns to callers.
 *
 * So the paging walk below executes production's ordering and production's
 * predicate over an in-memory table. If either regresses to block_height
 * alone, the walk drops rows and these tests go red.
 */

import { assertEquals, assert, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { PAGE_ORDER, cursorOrExpression, nextCursorFrom } from './index.ts';
import type { PageCursor } from './index.ts';

interface Row {
  block_height: number;
  txid_blind_index_hex: string;
}

/** Distinct 64-char lowercase hex, the shape the column actually stores. */
function blind(n: number): string {
  return n.toString(16).padStart(64, '0');
}

// ── comparator, built from production's PAGE_ORDER ─────────────────────
//
// Ordering of the hex column is a plain string compare. That matches Postgres
// for this column specifically because the values are fixed-length lowercase
// [0-9a-f]: no case folding, no punctuation and no variable length, so every
// collation Postgres would plausibly run agrees with byte order here. This
// shortcut is safe for THIS column and would not be safe for free text.
function compareByPageOrder(a: Row, b: Row): number {
  for (const o of PAGE_ORDER) {
    const av = (a as unknown as Record<string, unknown>)[o.column];
    const bv = (b as unknown as Record<string, unknown>)[o.column];
    let c = 0;
    if (typeof av === 'number' && typeof bv === 'number') c = av - bv;
    else c = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
    if (c !== 0) return o.ascending ? c : -c;
  }
  return 0;
}

// ── a very small PostgREST filter evaluator ────────────────────────────
//
// Understands only the grammar cursorOrExpression emits:
//   <col>.<op>.<val>  |  and(<term>,<term>,...)
// joined at the top level by commas, which .or() reads as OR. Anything else
// throws rather than silently evaluating to true, so a change in the emitted
// expression surfaces as a failure here instead of as a green test over a
// predicate this file no longer understands.
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function evalTerm(term: string, row: Row): boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    return splitTopLevel(term.slice(4, -1)).every((t) => evalTerm(t, row));
  }
  const m = term.match(/^([a-z_]+)\.(lt|gt|eq)\.(.+)$/);
  if (!m) throw new Error(`unsupported PostgREST term: ${term}`);
  const [, col, op, rawVal] = m;
  const cell = (row as unknown as Record<string, unknown>)[col];
  if (cell === undefined) throw new Error(`unknown column in term: ${col}`);
  const val: string | number = typeof cell === 'number' ? Number(rawVal) : rawVal;
  if (op === 'lt') return cell < val;
  if (op === 'gt') return cell > val;
  return cell === val;
}

/** .or() semantics: the top-level comma-separated terms are ORed. */
function matchesOr(expr: string, row: Row): boolean {
  return splitTopLevel(expr).some((t) => evalTerm(t, row));
}

/**
 * Walk every page exactly the way the handler does: sort by PAGE_ORDER, apply
 * the cursor predicate, over-fetch by one to detect has_more, hand back the
 * cursor from nextCursorFrom. Returns the concatenation of all pages.
 */
function walkAllPages(table: Row[], limit: number): { rows: Row[]; pages: number } {
  const collected: Row[] = [];
  let cursor: PageCursor | null = null;
  let pages = 0;

  for (;;) {
    const sorted = [...table].sort(compareByPageOrder);
    const filtered = cursor
      ? sorted.filter((r) => matchesOr(cursorOrExpression(cursor as PageCursor), r))
      : sorted;
    const fetched = filtered.slice(0, limit + 1);
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;

    collected.push(...page);
    pages++;
    cursor = nextCursorFrom(page, hasMore);
    if (!cursor) break;

    // A cursor that stops advancing would loop forever; fail loudly instead.
    assert(pages <= table.length + 2, 'pagination did not terminate');
  }
  return { rows: collected, pages };
}

// ── the case the Auditor asked for ─────────────────────────────────────
//
// Three rows share one block_height and the page limit is smaller than that
// block, so at least one page boundary lands strictly inside the shared block.
// That is precisely the position where the old block_height-only cursor
// discarded the rest of the block.

Deno.test('pagination: a page boundary inside a shared block returns every row exactly once', () => {
  const table: Row[] = [
    { block_height: 900, txid_blind_index_hex: blind(1) },
    { block_height: 800, txid_blind_index_hex: blind(2) },
    { block_height: 800, txid_blind_index_hex: blind(3) },
    { block_height: 800, txid_blind_index_hex: blind(4) }, // three rows in block 800
    { block_height: 700, txid_blind_index_hex: blind(5) },
  ];

  const { rows } = walkAllPages(table, 2); // limit 2 < the 3 rows in block 800

  assertEquals(rows.length, table.length, 'every stored row must be returned');
  const seen = new Set(rows.map((r) => `${r.block_height}:${r.txid_blind_index_hex}`));
  assertEquals(seen.size, table.length, 'no row may be returned twice');
  for (const t of table) {
    assert(
      seen.has(`${t.block_height}:${t.txid_blind_index_hex}`),
      `row ${t.block_height}/${t.txid_blind_index_hex.slice(0, 8)} was dropped between pages`,
    );
  }
});

Deno.test('pagination: holds at every limit from 1 to n over a block of five', () => {
  const table: Row[] = [
    { block_height: 500, txid_blind_index_hex: blind(10) },
    { block_height: 500, txid_blind_index_hex: blind(11) },
    { block_height: 500, txid_blind_index_hex: blind(12) },
    { block_height: 500, txid_blind_index_hex: blind(13) },
    { block_height: 500, txid_blind_index_hex: blind(14) }, // one block, five rows
    { block_height: 499, txid_blind_index_hex: blind(15) },
  ];

  for (let limit = 1; limit <= table.length + 1; limit++) {
    const { rows } = walkAllPages(table, limit);
    const seen = new Set(rows.map((r) => r.txid_blind_index_hex));
    assertEquals(rows.length, table.length, `limit ${limit}: wrong row count`);
    assertEquals(seen.size, table.length, `limit ${limit}: a row repeated`);
  }
});

Deno.test('pagination: pages arrive in PAGE_ORDER and the order is total', () => {
  const table: Row[] = [
    { block_height: 800, txid_blind_index_hex: blind(3) },
    { block_height: 900, txid_blind_index_hex: blind(1) },
    { block_height: 800, txid_blind_index_hex: blind(2) },
    { block_height: 800, txid_blind_index_hex: blind(4) },
  ];
  const { rows } = walkAllPages(table, 2);

  for (let i = 1; i < rows.length; i++) {
    const c = compareByPageOrder(rows[i - 1], rows[i]);
    assert(c < 0, `rows ${i - 1} and ${i} are out of order or tied (compare returned ${c})`);
  }
});

// ── the bug this replaced, kept executable ─────────────────────────────
//
// Proof that the walk above can actually detect the defect: the same table run
// against the OLD block_height-only predicate must lose rows. If this ever
// stops losing rows, the harness is not exercising the boundary and the tests
// above are worth nothing.

Deno.test('regression proof: the old block_height-only cursor DOES drop rows', () => {
  const table: Row[] = [
    { block_height: 900, txid_blind_index_hex: blind(1) },
    { block_height: 800, txid_blind_index_hex: blind(2) },
    { block_height: 800, txid_blind_index_hex: blind(3) },
    { block_height: 800, txid_blind_index_hex: blind(4) },
    { block_height: 700, txid_blind_index_hex: blind(5) },
  ];
  const limit = 2;
  const collected: Row[] = [];
  let before: number | null = null;

  for (let guard = 0; guard < 10; guard++) {
    const sorted = [...table].sort((a, b) => b.block_height - a.block_height);
    const filtered = before === null ? sorted : sorted.filter((r) => r.block_height < before!);
    const fetched = filtered.slice(0, limit + 1);
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    collected.push(...page);
    if (!hasMore || page.length === 0) break;
    before = page[page.length - 1].block_height;
  }

  assert(
    collected.length < table.length,
    'the old cursor must lose rows here; if it does not, this table no longer ' +
      'puts a page boundary inside the shared block and the tests above prove nothing',
  );
});

// ── the exported helpers, checked directly ─────────────────────────────

Deno.test('cursorOrExpression emits the keyset predicate, not a bare block compare', () => {
  const expr = cursorOrExpression({ before_block: 800, before_txid_blind_index_hex: blind(3) });
  assertEquals(
    expr,
    `block_height.lt.800,and(block_height.eq.800,txid_blind_index_hex.lt.${blind(3)})`,
  );
  assert(expr.includes('txid_blind_index_hex'), 'cursor must carry the unique tiebreaker');
});

Deno.test('cursorOrExpression: the tie arm admits the next row in the same block', () => {
  const expr = cursorOrExpression({ before_block: 800, before_txid_blind_index_hex: blind(3) });
  // Same block, lower blind index: must still be reachable on the next page.
  assert(matchesOr(expr, { block_height: 800, txid_blind_index_hex: blind(2) }));
  // The cursor row itself must not repeat.
  assert(!matchesOr(expr, { block_height: 800, txid_blind_index_hex: blind(3) }));
  // Already-returned row from the same block must not repeat.
  assert(!matchesOr(expr, { block_height: 800, txid_blind_index_hex: blind(4) }));
  // Lower block: always reachable.
  assert(matchesOr(expr, { block_height: 700, txid_blind_index_hex: blind(9) }));
});

Deno.test('nextCursorFrom returns null on the last page so callers terminate', () => {
  const rows = [{ block_height: 800, txid_blind_index_hex: blind(2) }];
  assertEquals(nextCursorFrom(rows, false), null, 'no cursor when has_more is false');
  assertEquals(nextCursorFrom([], true), null, 'no cursor when the page is empty');
  assertEquals(nextCursorFrom(rows, true), {
    before_block: 800,
    before_txid_blind_index_hex: blind(2),
  });
});

Deno.test('PAGE_ORDER descends on both columns and names the unique tiebreaker second', () => {
  assertEquals(PAGE_ORDER.length, 2, 'a single-column order is not a total order on this table');
  assertEquals(PAGE_ORDER[0].column, 'block_height');
  assertEquals(PAGE_ORDER[1].column, 'txid_blind_index_hex');
  for (const o of PAGE_ORDER) assertEquals(o.ascending, false, 'newest first');
});

Deno.test('the evaluator refuses grammar it does not model', () => {
  // Guards the guard: if cursorOrExpression starts emitting something richer,
  // this file must fail rather than quietly mis-evaluate the new predicate.
  assertThrows(() => matchesOr('block_height.in.(1,2)', { block_height: 1, txid_blind_index_hex: blind(1) }));
});
