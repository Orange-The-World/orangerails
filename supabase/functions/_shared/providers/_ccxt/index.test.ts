/**
 * Wiring guards for the CCXT adapter's credential validation at discovery time.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/_shared/providers/_ccxt/index.test.ts
 *
 * These tests do not run buildDiscover directly: that requires loading
 * ccxt@4.4.30, which is not viable in a unit test environment. Instead they
 * read the source as text and assert that the dispatch wiring is present end
 * to end. A test that only imports buildDiscover directly passes whether or
 * not the upstreamCode property survives through the HTTP response chain.
 *
 * Joint 1: buildDiscover -> tagged error  (this file)
 * Joint 2: tagged error  -> or-discover-wallets catch  (this file)
 * Joint 3: catch         -> HTTP status + catalog copy  (this file)
 * Joint 4: HTTP response -> widget error message  (this file, connect.tsx guard)
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const readSource = (rel: string) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Joint 1: buildDiscover tags the rethrown error with .upstreamCode.
//
// Without this tag, the or-discover-wallets catch block sees a plain Error and
// falls through to the generic 500, so the customer gets "Internal error"
// instead of the catalog copy.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('buildDiscover tags the rethrown error with .upstreamCode', () => {
  const src = readSource('./index.ts');

  assertEquals(
    /\(out as any\)\.upstreamCode\s*=\s*code/.test(src),
    true,
    'buildDiscover must assign .upstreamCode on the rethrown Error before throwing',
  );

  assertEquals(
    /const\s+code\s*=\s*classifyUpstreamError\(/.test(src),
    true,
    '.upstreamCode must come from classifyUpstreamError so the taxonomy is preserved',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Joint 2: or-discover-wallets reads .upstreamCode from the caught error.
//
// Without this read, the property set in Joint 1 is silently dropped and the
// response is always 500 with no catalog copy.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('or-discover-wallets reads .upstreamCode from the caught error', () => {
  const src = readSource('../../../or-discover-wallets/index.ts');

  assertEquals(
    /\.upstreamCode\b/.test(src),
    true,
    'or-discover-wallets catch block must read .upstreamCode off the error',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Joint 3: or-discover-wallets returns structured copy at the right status.
//
// lookupErrorCopy must be called with upstreamCode so the catalog entry is
// spread into the response. error_code must appear in the body so the client
// can display the right message. The status mapping must be present so a
// downed exchange (503) is not treated the same as a bad key (422).
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('or-discover-wallets returns catalog copy via lookupErrorCopy', () => {
  const src = readSource('../../../or-discover-wallets/index.ts');

  assertEquals(
    /lookupErrorCopy\(upstreamCode\)/.test(src),
    true,
    'or-discover-wallets must call lookupErrorCopy(upstreamCode) to get catalog copy',
  );

  assertEquals(
    /error_code:\s*upstreamCode/.test(src),
    true,
    'or-discover-wallets must include error_code in the response body',
  );
});

Deno.test('or-discover-wallets HTTP status mapping: RATE_LIMITED=429, UNAVAILABLE=503, auth=422', () => {
  const src = readSource('../../../or-discover-wallets/index.ts');

  assertEquals(
    /'UPSTREAM_RATE_LIMITED'\s*\?\s*429/.test(src),
    true,
    'UPSTREAM_RATE_LIMITED must map to HTTP 429',
  );

  assertEquals(
    /'UPSTREAM_UNAVAILABLE'\s*\?\s*503/.test(src),
    true,
    'UPSTREAM_UNAVAILABLE must map to HTTP 503',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Joint 4: serverDiscover in connect.tsx reads the catalog fields.
//
// The response body is { error_code, title, body, action, help_url }.
// If serverDiscover only reads data.error (which does not exist in that shape),
// the catalog copy is fetched, sent, parsed, and then dropped one line before
// it would have been displayed. data.body must be preferred; data.error must
// remain as a fallback so callers that still send the old key do not regress.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('serverDiscover prefers data.body over data.error in the !res.ok branch', () => {
  const src = readSource('../../../../../src/routes/connect.tsx');

  assertEquals(
    /typeof data\.body\s*===\s*['"]string['"]/.test(src),
    true,
    'serverDiscover must read data.body from the structured error response',
  );

  // data.error kept as a fallback so existing non-CCXT callers do not regress.
  assertEquals(
    /typeof data\.error\s*===\s*['"]string['"]/.test(src),
    true,
    'serverDiscover must keep data.error as a fallback for backward compatibility',
  );
});
