/**
 * Tests for the SSRF net-guard.
 *
 * Run with:
 *   deno test supabase/functions/_shared/net-guard.test.ts
 *
 * DNS tests use an injected resolver so the suite runs fully offline.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertPublicHttpUrl, NetGuardError } from './net-guard.ts';
import { btcpayAdapter } from './providers/btcpay/index.ts';

// --------------- blocked address table -----------------------------------
// One representative per range plus the canonical EC2 metadata endpoint.

const BLOCKED: Array<[string, string]> = [
  ['loopback 127/8',               'https://127.0.0.1/api'],
  ['private 10/8',                 'https://10.0.0.1/api'],
  ['private 172.16/12',            'https://172.16.5.1/api'],
  ['private 192.168/16',           'https://192.168.1.1/api'],
  ['link-local metadata endpoint', 'https://169.254.169.254/latest/meta-data'],
  ['CGNAT 100.64/10',              'https://100.64.0.1/api'],
  ['unspecified 0.0.0.0',          'https://0.0.0.0/api'],
  ['loopback ::1',                 'https://[::1]/api'],
  ['link-local fe80::/10',         'https://[fe80::1]/api'],
  ['unique-local fc00::/7',        'https://[fc00::1]/api'],
  ['IPv4-mapped loopback',         'https://[::ffff:127.0.0.1]/api'],
];

for (const [label, url] of BLOCKED) {
  Deno.test(`blocks ${label}: ${url}`, async () => {
    await assertRejects(
      () => assertPublicHttpUrl(url),
      NetGuardError,
    );
  });
}

// --------------- scheme and userinfo -------------------------------------

Deno.test('blocks http: scheme', async () => {
  await assertRejects(
    () => assertPublicHttpUrl('http://example.com/api'),
    NetGuardError,
  );
});

Deno.test('blocks userinfo in URL', async () => {
  await assertRejects(
    () => assertPublicHttpUrl('https://user:pass@example.com/api'),
    NetGuardError,
  );
});

// --------------- passing cases -------------------------------------------

Deno.test('passes a public IPv4 literal', async () => {
  const url = await assertPublicHttpUrl('https://93.184.216.34/api');
  assertEquals(url.hostname, '93.184.216.34');
});

Deno.test('passes hostname resolving to public IP (injected resolver)', async () => {
  const fakeResolve = async (_host: string, rt: 'A' | 'AAAA'): Promise<string[]> =>
    rt === 'A' ? ['93.184.216.34'] : [];
  const url = await assertPublicHttpUrl('https://example.com/api', {
    resolveDns: fakeResolve,
  });
  assertEquals(url.hostname, 'example.com');
});

Deno.test('blocks hostname resolving to private IP (injected resolver)', async () => {
  const fakeResolve = async (_host: string, rt: 'A' | 'AAAA'): Promise<string[]> =>
    rt === 'A' ? ['192.168.1.100'] : [];
  await assertRejects(
    () => assertPublicHttpUrl('https://internal.corp/api', { resolveDns: fakeResolve }),
    NetGuardError,
  );
});

// --------------- btcpay integration: guard fires before fetch ------------
// Proves assertPublicHttpUrl is called before any network I/O in btcpayGet.

Deno.test('btcpayGet: blocks private URL without calling fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  (globalThis as unknown as { fetch: unknown }).fetch = (): never => {
    fetchCalled = true;
    throw new Error('fetch must not be called when guard blocks');
  };
  try {
    await assertRejects(
      () =>
        btcpayAdapter.discoverWallets({
          btcpay_url: 'https://169.254.169.254',
          api_key: 'test-key',
        }),
      NetGuardError,
    );
    assertEquals(fetchCalled, false, 'fetch was called; guard did not run first');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
