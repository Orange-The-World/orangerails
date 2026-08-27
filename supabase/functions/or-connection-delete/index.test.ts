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

Deno.test('a failed cleanup does NOT block the connection delete', () => {
  // This is the half a well-meaning future edit is most likely to break.
  // Turning the cleanup failure into a 500 would stop a customer deleting a
  // connection because an unrelated cleanup query failed.
  const branch = failedCleanupBranch();
  assert(branch.length > 0, 'failed-cleanup branch came back empty');
  assertEquals(
    /\breturn\b/.test(branch),
    false,
    'the swDelErr branch must not return; the connection delete has to proceed',
  );
  assertEquals(
    /\bthrow\b/.test(branch),
    false,
    'the swDelErr branch must not throw; the connection delete has to proceed',
  );
  assertEquals(
    branch.includes('jsonResponse'),
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
