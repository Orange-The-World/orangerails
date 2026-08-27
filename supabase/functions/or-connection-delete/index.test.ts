/**
 * Deno tests for or-connection-delete. DL-1723.
 *
 * Run with:
 *   deno test --allow-read supabase/functions/or-connection-delete/index.test.ts
 *
 * WHY SOURCE INSPECTION. Same rationale the or-sync tests already state: a
 * unit test over an extracted pure helper cannot detect that a guard was
 * removed from the live call site, and the live call site is the entire
 * subject here. The defect being pinned is not a wrong value returned by a
 * function, it is a failure path that did not report.
 *
 * TWO HALVES, AND THE SECOND MATTERS AS MUCH AS THE FIRST.
 *
 *   1. A failed source_wallets cleanup must reach the error tracker.
 *      console.error alone does not, which is how this failure stayed
 *      invisible: it left source_wallets rows pointing at a connection id
 *      that was about to stop existing, and nothing recorded it.
 *
 *   2. The connection delete must STILL PROCEED. Blocking a customer's
 *      delete because a cleanup query failed is its own bad outcome, and
 *      or-link-complete's liveness guard is the backstop that catches the
 *      orphaned rows on the next link.
 *
 * A future edit that "fixes" this by turning the cleanup failure into a 500
 * satisfies the first half and breaks the second, so the second is asserted
 * explicitly rather than left to reviewer memory.
 *
 * Every test below first asserts it FOUND the block it is about to inspect.
 * Without that, a renamed variable would make the search return nothing and
 * the assertions would pass vacuously over an empty string, which is exactly
 * the kind of green that means nothing.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SOURCE = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

/** Marker for the start of the failed-cleanup branch. */
const BLOCK_START = 'if (swDelErr) {';
/** Marker for the first line after that branch. */
const BLOCK_END = '// Step 3:';

/**
 * Remove `//` line comments and block comments.
 *
 * WHY THIS EXISTS, and it is worth reading before deleting it. The control
 * flow assertions below search for `return` and `throw`. The branch they scan
 * carries a comment explaining what goes wrong when an orphan survives, and
 * that prose contains the words "and return success with nothing written". A
 * raw text search therefore matched English and failed on correct code.
 *
 * Scanning comments for control flow is wrong in both directions: it fails on
 * a correct branch that merely describes a return, and it would pass a broken
 * one whose real return sat inside a commented-out line. Strip first, then
 * assert on what actually executes.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The text of the failed-cleanup branch, from the `if` to the start of Step 3.
 *
 * Throws rather than returning an empty string when either marker is missing,
 * so a rename fails loudly instead of turning every assertion below into a
 * pass over nothing.
 */
function failedCleanupBranch(): string {
  const start = SOURCE.indexOf(BLOCK_START);
  const end = SOURCE.indexOf(BLOCK_END, start);
  if (start === -1) {
    throw new Error(`could not find "${BLOCK_START}" in index.ts; was swDelErr renamed?`);
  }
  if (end === -1 || end <= start) {
    throw new Error(`could not find "${BLOCK_END}" after the cleanup branch in index.ts`);
  }
  return SOURCE.slice(start, end);
}

Deno.test('the source is readable and non-trivial, so the checks below mean something', () => {
  // Guards the whole file: if the read silently returned nothing, every
  // "does not contain" assertion below would pass while proving nothing.
  assert(SOURCE.length > 1000, 'index.ts read back as suspiciously short');
  assert(SOURCE.includes('or-connection-delete'), 'read the wrong file');
});

Deno.test('reportError is imported, so the failure can reach the error tracker', () => {
  assertEquals(
    SOURCE.includes("import { wrapSentryHandler, reportError } from '../_shared/sentry.ts';"),
    true,
    'reportError must be imported from _shared/sentry.ts; console.error alone does not report',
  );
});

Deno.test('a failed source_wallets cleanup is reported, tagged to this function', () => {
  const branch = failedCleanupBranch();
  assert(branch.length > 0, 'failed-cleanup branch came back empty');
  assertEquals(
    branch.includes("reportError(swDelErr, 'or-connection-delete', req)"),
    true,
    'the swDelErr branch must call reportError with the swDelErr object and this function name, ' +
      'so the resulting issue is attributable to or-connection-delete',
  );
});

Deno.test('a failed cleanup is still logged as well as reported', () => {
  // The log line is the local breadcrumb and the report is the alarm. Losing
  // either one costs a different kind of debugging.
  const branch = failedCleanupBranch();
  assertEquals(
    branch.includes("console.error('[or-connection-delete] source_wallets cleanup failed:', swDelErr)"),
    true,
    'the local error log must survive alongside the report',
  );
});

Deno.test('the comment stripper actually strips, so the next test is not vacuous', () => {
  // A stripper that quietly returned its input unchanged would reintroduce
  // the prose-matching bug this exists to prevent, and a stripper that ate
  // everything would make the control-flow assertions pass over nothing.
  const sample = 'const a = 1; // return this is prose\n/* throw also prose */ const b = 2;';
  const stripped = stripComments(sample);
  assertEquals(/\breturn\b/.test(stripped), false, 'line comments must be removed');
  assertEquals(/\bthrow\b/.test(stripped), false, 'block comments must be removed');
  assert(stripped.includes('const a = 1;'), 'code before a comment must survive');
  assert(stripped.includes('const b = 2;'), 'code after a comment must survive');
});

Deno.test('a failed cleanup does NOT block the connection delete', () => {
  // This is the half a well-meaning future edit is most likely to break.
  // Turning the cleanup failure into a 500 would stop a customer deleting a
  // connection because an unrelated cleanup query failed.
  const branch = failedCleanupBranch();
  assert(branch.length > 0, 'failed-cleanup branch came back empty');

  const code = stripComments(branch);
  // The branch is mostly explanatory comment, so prove something executable
  // survived the strip before asserting on what is missing from it.
  assert(
    code.includes('reportError'),
    'stripping comments removed the executable code too; the assertions below would be vacuous',
  );

  assertEquals(
    /\breturn\b/.test(code),
    false,
    'the swDelErr branch must not return; the connection delete has to proceed',
  );
  assertEquals(
    /\bthrow\b/.test(code),
    false,
    'the swDelErr branch must not throw; the connection delete has to proceed',
  );
  assertEquals(
    code.includes('jsonResponse'),
    false,
    'the swDelErr branch must not build a response; it is not a terminal path',
  );
});

Deno.test('the connection delete still runs after the cleanup branch', () => {
  // Proves the ordering the branch test assumes: Step 3 exists, and it comes
  // after the cleanup rather than having been moved above it.
  const cleanupIdx = SOURCE.indexOf(BLOCK_START);
  const stepThreeIdx = SOURCE.indexOf(BLOCK_END);
  const deleteIdx = SOURCE.indexOf(".delete({ count: 'exact' })", stepThreeIdx);

  assert(cleanupIdx !== -1, 'cleanup branch not found');
  assert(stepThreeIdx > cleanupIdx, 'Step 3 must come after the source_wallets cleanup');
  assert(deleteIdx !== -1, 'the counted connection delete must still be present in Step 3');
});

Deno.test('the success response is unchanged', () => {
  // DL-1723 is a reporting fix. The response contract is not part of it, and
  // a change here would be a silent breaking change for every caller.
  assertEquals(
    SOURCE.includes("const response: Record<string, unknown> = { ok: true };"),
    true,
    'the ok:true success response must be untouched by this fix',
  );
});
