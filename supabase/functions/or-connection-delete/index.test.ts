/**
 * Deno tests for or-connection-delete.
 *
 * Run with:
 *   deno test --allow-read supabase/functions/or-connection-delete/index.test.ts
 *
 * Three independent groups in this file:
 *
 * 1. STEALTH FALLBACK (DL-1033). Tests tryDeleteStealthConnection, which
 *    handles the case where a connection_id is absent from `connections`
 *    but present in (or absent from) `stealth_connections`:
 *      a. Stealth id deleted successfully (count=1).
 *      b. Foreign subaccount: id exists in stealth_connections but belongs
 *         to a different scope, delete matches zero rows => 404.
 *      c. Unknown id: not in either table, delete matches zero rows => 404.
 *
 * 2. SOURCE_WALLETS CLEANUP REPORTING: SOURCE INSPECTION (OR-T0477 / DL-1723).
 *    Source inspection over the live handler, not a unit test over an extracted
 *    helper, because the defect being pinned is that a failure path did
 *    not report, and the live call site is the entire subject. See the
 *    comment block above `failedCleanupBranch()` below for the full
 *    rationale, including why control flow is asserted after stripping
 *    comments.
 *
 * 3. SOURCE_WALLETS CLEANUP REPORTING: RUNTIME PROOF (OR-T0477). Runtime
 *    tests that call deleteConnectionRow directly with a stubbed serviceClient
 *    and a spy reportFn, proving the error is reported and the response is
 *    ok:true when source_wallets.delete() fails.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tryDeleteStealthConnection, deleteConnectionRow } from './index.ts';

// --- Group 1: stealth fallback (DL-1033) ---

const SUBACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PLATFORM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const APP_USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

interface FilterCall {
  col: string;
  val: unknown;
}

interface DeleteRecord {
  table: string;
  filters: FilterCall[];
}

interface MockOpts {
  subaccountRow?: { platform_id: string; external_user_id: string } | null;
  subaccountError?: unknown;
  stealthDeleteCount?: number;
  stealthDeleteError?: unknown;
  deleteRecords: DeleteRecord[];
}

// deno-lint-ignore no-explicit-any
function makeMockClient(opts: MockOpts): any {
  return {
    from(table: string) {
      const filters: FilterCall[] = [];
      const chain: Record<string, unknown> = {
        select(_cols: string) { return chain; },
        delete(_deleteOpts?: unknown) { return chain; },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return chain;
        },
        maybeSingle() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: opts.subaccountRow ?? null,
              error: opts.subaccountError ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        then(onResolve: (r: unknown) => unknown): any {
          if (table === 'stealth_connections') {
            opts.deleteRecords.push({ table, filters: [...filters] });
            return Promise.resolve({
              data: null,
              error: opts.stealthDeleteError ?? null,
              count: opts.stealthDeleteCount ?? 0,
            }).then(onResolve);
          }
          return Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
        },
      };
      return chain;
    },
  };
}

Deno.test('stealth id in same subaccount is deleted (count=1)', async () => {
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 1,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, CONNECTION_ID, SUBACCOUNT_ID);

  assertEquals(result, { deleted: true });
  // Delete was attempted exactly once
  assertEquals(deleteRecords.length, 1);
  // All three ownership filters applied: id, platform_id, app_user_id
  const { filters } = deleteRecords[0];
  assertEquals(filters.some(f => f.col === 'id' && f.val === CONNECTION_ID), true);
  assertEquals(filters.some(f => f.col === 'platform_id' && f.val === PLATFORM_ID), true);
  assertEquals(filters.some(f => f.col === 'app_user_id' && f.val === APP_USER_ID), true);
});

Deno.test('foreign subaccount: count=0 returns notFound, no widening', async () => {
  // The id may exist in stealth_connections but belong to a different
  // (platform_id, app_user_id) pair. The delete should match zero rows
  // and return notFound without touching any other row.
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 0,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, CONNECTION_ID, SUBACCOUNT_ID);

  assertEquals(result, { notFound: true });
  // Ownership filters were still applied (scope was not widened)
  assertEquals(deleteRecords.length, 1);
  const { filters } = deleteRecords[0];
  assertEquals(filters.some(f => f.col === 'platform_id'), true);
  assertEquals(filters.some(f => f.col === 'app_user_id'), true);
});

Deno.test('unknown id absent from connections and stealth_connections returns notFound', async () => {
  const UNKNOWN_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const deleteRecords: DeleteRecord[] = [];
  const client = makeMockClient({
    subaccountRow: { platform_id: PLATFORM_ID, external_user_id: APP_USER_ID },
    stealthDeleteCount: 0,
    deleteRecords,
  });

  const result = await tryDeleteStealthConnection(client, UNKNOWN_ID, SUBACCOUNT_ID);

  assertEquals(result, { notFound: true });
});

// --- Group 2: source_wallets cleanup reporting: source inspection (OR-T0477 / DL-1723) ---

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

Deno.test('deleteConnectionRow defaults reportFn to the real reportError', () => {
  // The reportFn parameter defaults to reportError so the production call
  // path is identical to before the extraction. Tests inject a spy via
  // reportFn; production callers omit it and get the real reporter.
  assertEquals(
    SOURCE.includes(
      'reportFn: (err: unknown, fn: string, req: Request) => Promise<void> = reportError',
    ),
    true,
    'deleteConnectionRow must default reportFn to reportError so the production path calls the real reporter',
  );
});

Deno.test('a failed source_wallets cleanup is reported, tagged to this function', () => {
  const branch = failedCleanupBranch();
  assert(branch.length > 0, 'failed-cleanup branch came back empty');
  assertEquals(
    branch.includes("reportFn(swDelErr, 'or-connection-delete', req)"),
    true,
    'the swDelErr branch must call reportFn with the swDelErr object and this function name, ' +
      'so the resulting issue is attributable to or-connection-delete; ' +
      'reportFn defaults to the real reportError so the production path is unchanged',
  );
});

Deno.test('a failed cleanup is still logged through the redaction boundary, as well as reported', () => {
  // The log line is the local breadcrumb and the report is the alarm. Losing
  // either one costs a different kind of debugging. dev's other console.error
  // call sites in this file all go through safeErrorLine (the shared secret
  // redaction boundary), so this branch must match that convention rather
  // than logging the raw error object directly.
  const branch = failedCleanupBranch();
  assertEquals(
    branch.includes("safeErrorLine('or-connection-delete', 'source-wallets-cleanup', swDelErr)"),
    true,
    'the local error log must go through safeErrorLine, same as every other console.error in this file',
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
    code.includes('reportFn'),
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
  // OR-T0477 / DL-1723 is a reporting fix. The response contract is not part
  // of it, and a change here would be a silent breaking change for every
  // caller.
  assertEquals(
    SOURCE.includes("const response: Record<string, unknown> = { ok: true };"),
    true,
    'the ok:true success response must be untouched by this fix',
  );
});

// --- Group 3: source_wallets cleanup reporting: runtime proof (OR-T0477) ---
//
// These tests call deleteConnectionRow directly, bypassing the HTTP layer and
// auth middleware, using the same stub-serviceClient pattern as Group 1. The
// goal is to prove that a forced source_wallets failure (a) calls reportFn and
// (b) still returns ok:true, at runtime and not just via source inspection.

interface DeleteRowMockOpts {
  sourceWalletsError?: unknown;
  connectionDeleteError?: unknown;
  connectionDeleteCount?: number;
}

// deno-lint-ignore no-explicit-any
function makeDeleteRowClient(opts: DeleteRowMockOpts): any {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        delete() { return chain; },
        eq() { return chain; },
        // deno-lint-ignore no-explicit-any
        then(onResolve: (r: unknown) => unknown): any {
          if (table === 'source_wallets') {
            return Promise.resolve({
              data: null,
              error: opts.sourceWalletsError ?? null,
            }).then(onResolve);
          }
          if (table === 'connections') {
            return Promise.resolve({
              data: null,
              error: opts.connectionDeleteError ?? null,
              count: opts.connectionDeleteCount ?? 1,
            }).then(onResolve);
          }
          return Promise.resolve({ data: null, error: null, count: 0 }).then(onResolve);
        },
      };
      return chain;
    },
  };
}

Deno.test('runtime: source_wallets error calls reportFn and returns ok:true', async () => {
  // This is the proof xo-5 asked for. Set up a serviceClient that returns an
  // error from source_wallets.delete() but succeeds on connections.delete().
  // Verify both halves of the acceptance: the failure is reported (reportFn
  // is called with the right error and function name), and the response is
  // still ok:true (the connection delete was not blocked).
  const swError = new Error('db timeout');
  let reportCallCount = 0;
  let reportedErr: unknown;
  let reportedFnName: string | undefined;

  const spyReport = async (err: unknown, fn: string, _req: Request): Promise<void> => {
    reportCallCount += 1;
    reportedErr = err;
    reportedFnName = fn;
  };

  const client = makeDeleteRowClient({ sourceWalletsError: swError });
  const req = new Request('https://example.com/functions/v1/or-connection-delete', {
    method: 'POST',
  });
  const cors = new Headers();

  const res = await deleteConnectionRow(
    client,
    CONNECTION_ID,
    SUBACCOUNT_ID,
    req,
    cors,
    undefined,
    spyReport,
  );

  // The connection delete succeeds and the response is ok:true
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { ok: true });

  // reportFn was called exactly once, with the original error and the right tag
  assertEquals(reportCallCount, 1, 'reportFn must be called exactly once when source_wallets fails');
  assertEquals(reportedErr, swError, 'reportFn must receive the original error object');
  assertEquals(
    reportedFnName,
    'or-connection-delete',
    'reportFn must be tagged with this function name so the GlitchTip issue is attributable',
  );
});

Deno.test('runtime: source_wallets success does not call reportFn', async () => {
  // Negative control: when source_wallets.delete() succeeds, reportFn must
  // not be called.
  let reportCallCount = 0;
  const spyReport = async (_err: unknown, _fn: string, _req: Request): Promise<void> => {
    reportCallCount += 1;
  };

  const client = makeDeleteRowClient({ sourceWalletsError: null });
  const req = new Request('https://example.com/functions/v1/or-connection-delete', {
    method: 'POST',
  });
  const cors = new Headers();

  const res = await deleteConnectionRow(
    client,
    CONNECTION_ID,
    SUBACCOUNT_ID,
    req,
    cors,
    undefined,
    spyReport,
  );

  assertEquals(res.status, 200);
  assertEquals((await res.json()), { ok: true });
  assertEquals(reportCallCount, 0, 'reportFn must not be called when source_wallets succeeds');
});
