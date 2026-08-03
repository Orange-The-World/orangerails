/**
 * DL-0557: ProviderAdapter custody field must fail-closed.
 *
 * An adapter that does not declare `custody` must be rejected at
 * construction time, not silently accepted with any default value.
 *
 * validateAdapter() is the construction-time gate. These tests cover:
 *   - missing custody throws
 *   - invalid custody string throws
 *   - valid values pass through
 */

import { assertThrows, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateAdapter } from '../types.ts';
import type { ProviderAdapter } from '../types.ts';

// Minimal stub that satisfies all required ProviderAdapter fields except
// the one being probed.
function makeStub(overrides: Record<string, unknown> = {}): ProviderAdapter {
  return {
    slug: 'test-stub',
    displayName: 'Test Stub',
    multiWallet: false,
    custody: 'custodial',
    credentialFields: [],
    discoverWallets: () => Promise.resolve([]),
    syncByWallets: () => Promise.resolve({ transactions: [], next_cursor: null }),
    syncAccountWide: () => Promise.resolve({ transactions: [], next_cursor: null }),
    ...overrides,
  } as unknown as ProviderAdapter;
}

Deno.test('DL-0557: adapter with custody absent throws at validateAdapter', () => {
  const stub = makeStub();
  // Delete the field entirely so it is truly absent at runtime (not just
  // undefined-valued), matching the scenario of a hand-written object literal
  // that never declared the key.
  const bare = { ...stub } as Record<string, unknown>;
  delete bare.custody;
  assertThrows(
    () => validateAdapter(bare as unknown as ProviderAdapter),
    Error,
    'custody',
  );
});

Deno.test('DL-0557: adapter with custody set to undefined throws', () => {
  const stub = makeStub();
  const bad = { ...stub, custody: undefined } as unknown as ProviderAdapter;
  assertThrows(
    () => validateAdapter(bad),
    Error,
    'custody',
  );
});

Deno.test('DL-0557: adapter with invalid custody string throws', () => {
  const bad = makeStub({ custody: 'self' });
  assertThrows(
    () => validateAdapter(bad),
    Error,
    'non_custodial',
  );
});

Deno.test('DL-0557: adapter with custody custodial passes through unchanged', () => {
  const stub = makeStub({ custody: 'custodial' });
  const result = validateAdapter(stub);
  assertEquals(result.custody, 'custodial');
  assertEquals(result.slug, stub.slug);
});

Deno.test('DL-0557: adapter with custody non_custodial passes through unchanged', () => {
  const stub = makeStub({ custody: 'non_custodial' });
  const result = validateAdapter(stub);
  assertEquals(result.custody, 'non_custodial');
});

Deno.test('DL-0557: error message names the adapter slug so the failure is actionable', () => {
  const bare = { ...makeStub({ slug: 'broken-adapter' }) } as Record<string, unknown>;
  delete bare.custody;
  let caught: Error | undefined;
  try {
    validateAdapter(bare as unknown as ProviderAdapter);
  } catch (e) {
    caught = e as Error;
  }
  if (!caught) throw new Error('expected validateAdapter to throw but it did not');
  if (!caught.message.includes('broken-adapter')) {
    throw new Error(`error message should name the slug; got: ${caught.message}`);
  }
});
