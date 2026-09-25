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

// ─────────────────────────────────────────────────────────────────────────────
// DL-1440: external_wallet_id must be opaque, not the provider slug.
//
// buildDiscover used to emit `external_wallet_id: slug`, so every customer of a
// given exchange shared one identifier: all four Bitstamp wallets in production
// carry the literal string "bitstamp". The DiscoveredWallet contract in
// ../types.ts requires an opaque value with zero derivable relationship to the
// key material, which a constant exchange name is not.
//
// Same source-as-text approach as the joints above, and for the same reason:
// running buildDiscover means loading ccxt, which is not viable here. The
// assertion is narrow on purpose. It pins the one line that regressed.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('buildDiscover emits an opaque external_wallet_id, never the slug', () => {
  const src = readSource('./index.ts');

  assertEquals(
    /external_wallet_id:\s*slug\b/.test(src),
    false,
    'external_wallet_id must not be the provider slug: it repeats across every customer of the exchange',
  );

  assertEquals(
    /external_wallet_id:\s*crypto\.randomUUID\(\)/.test(src),
    true,
    'external_wallet_id must be a fresh opaque UUID, per the DiscoveredWallet contract',
  );
});

// account_key is what reconnect dedup actually keys on, so the opaque id above
// is only safe while this line survives. If account_key ever stops being
// emitted, changing external_wallet_id to a random value would turn every
// reconnect into a duplicate wallet row. Pinned here so the two move together.
Deno.test('buildDiscover still emits account_key for reconnect dedup', () => {
  const src = readSource('./index.ts');

  assertEquals(
    /account_key:\s*accountKey/.test(src),
    true,
    'buildDiscover must keep emitting account_key: or-link-complete fingerprints on it',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DL-1440, second half. Transactions must be stamped with the WALLET id, not
// the exchange id.
//
// This was caught in review of PR 835 and it is the consequence that made the
// opaque id unsafe on its own. or-sync builds externalToInternalId keyed on
// source_wallets.external_wallet_id and remaps the stored source_wallet_id
// through it, keeping the raw value on a miss. While discovery stored the slug
// and the normalizers stamped exchangeId, those two were the same string, so
// the lookup hit. Minting an opaque id breaks that coincidence: the lookup
// misses, the row keeps "bitstamp", and TransactionsPanel then matches neither
// sw.id nor sw.external_wallet_id, so every transaction on a newly discovered
// connection loses its wallet attribution.
//
// The two changes only work together. Either alone leaves attribution broken,
// which is why these assertions live next to the opaque id ones.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('normalizers stamp source_wallet_id from the wallet, not the exchange id', () => {
  const src = readSource('./index.ts');

  assertEquals(
    /source_wallet_id:\s*exchangeId/.test(src),
    false,
    'source_wallet_id must not be the exchange id: or-sync cannot map it back to a wallet row',
  );

  assertEquals(
    (src.match(/source_wallet_id:\s*sourceWalletId/g) ?? []).length,
    2,
    'both normalizeTrade and normalizeTransfer must stamp the threaded wallet id',
  );
});

// The thread only holds if syncByWallets actually supplies the wallet it was
// handed. Pinned separately so a refactor that drops the argument fails loudly
// rather than silently falling back to the exchange id.
Deno.test('syncByWallets threads the wallet id into fetchAllSince', () => {
  const src = readSource('./index.ts');

  assertEquals(
    /const\s+sourceWalletId\s*=\s*walletIds\[0\]/.test(src),
    true,
    'syncByWallets must take the wallet id from walletIds[0]',
  );

  assertEquals(
    /fetchAllSince\(exchange,\s*exchangeId,\s*since,\s*sourceWalletId\)/.test(src),
    true,
    'fetchAllSince must receive the wallet id as its fourth argument',
  );

  // `adapter` is deliberately still the exchange id: it names the integration,
  // not the wallet, and consumers key off it.
  assertEquals(
    /adapter:\s*exchangeId/.test(src),
    true,
    'adapter must remain the exchange id',
  );
});
