/**
 * Deno tests for the Strike adapter's per-currency discoverWallets().
 *
 * Run with:
 *   deno test supabase/functions/_shared/providers/strike/discover.test.ts
 *
 * discover() calls the live Strike API through global fetch. We stub fetch by
 * URL so the test is deterministic and offline. The invariants proven here are
 * the acceptance criteria for the per-currency rework: a BTC+USD account yields
 * two wallets, a USD-only account yields one, a currency seen only in history
 * still yields a wallet, external_wallet_id is a fresh opaque UUID that never
 * equals the receiverId, and the adapter emits NO wallet_fingerprint (that work
 * lives in the write path, not the adapter).
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { strikeAdapter } from './index.ts';

interface StubResponses {
  balances: Array<{ currency: string; current: string }>;
  invoiceCurrencies: string[];
  receiverId: string;
}

function installFetchStub(r: StubResponses): () => void {
  const original = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/balances')) {
      return Promise.resolve(json(r.balances));
    }
    if (url.includes('/invoices?$top=3')) {
      // receiverId source: three invoices, constant receiverId.
      return Promise.resolve(
        json({
          items: [0, 1, 2].map(() => ({
            receiverId: r.receiverId,
            amount: { amount: '1.00', currency: 'USD' },
          })),
        }),
      );
    }
    if (url.includes('/invoices?$top=100')) {
      return Promise.resolve(
        json({
          items: r.invoiceCurrencies.map((c) => ({
            receiverId: r.receiverId,
            amount: { amount: '1.00', currency: c },
          })),
        }),
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.test('discover: BTC + USD account yields two wallets, one per currency', async () => {
  const restore = installFetchStub({
    balances: [
      { currency: 'BTC', current: '0.5' },
      { currency: 'USD', current: '10.00' },
    ],
    invoiceCurrencies: ['USD'],
    receiverId: 'acct-btc-usd',
  });
  try {
    const wallets = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
    assertEquals(wallets.length, 2);
    assertEquals(wallets.map((w) => w.currency).sort(), ['BTC', 'USD']);
    for (const w of wallets) {
      assert(UUID_RE.test(w.external_wallet_id), `external_wallet_id is a UUID: ${w.external_wallet_id}`);
      assert(w.external_wallet_id !== 'acct-btc-usd', 'external_wallet_id must not leak receiverId');
      // The adapter must NOT emit a fingerprint: it lacks the subaccount context
      // needed for the standard fingerprint. That work lives in the write path.
      assertEquals(w.wallet_fingerprint, undefined);
      // account_key is the receiverId, carried server-side only for the write
      // path. or-discover-wallets records it and strips it before responding.
      assertEquals(w.account_key, 'acct-btc-usd');
    }
  } finally {
    restore();
  }
});

Deno.test('discover: USD-only account yields exactly one wallet', async () => {
  const restore = installFetchStub({
    balances: [{ currency: 'USD', current: '42.00' }],
    invoiceCurrencies: ['USD'],
    receiverId: 'acct-usd-only',
  });
  try {
    const wallets = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
    assertEquals(wallets.length, 1);
    assertEquals(wallets[0].currency, 'USD');
    assertEquals(wallets[0].wallet_fingerprint, undefined);
  } finally {
    restore();
  }
});

Deno.test('discover: currency seen only in history (zero balance) still yields a wallet', async () => {
  const restore = installFetchStub({
    // BTC spent to zero balance, but present in invoice history.
    balances: [{ currency: 'USD', current: '5.00' }],
    invoiceCurrencies: ['USD', 'BTC'],
    receiverId: 'acct-history',
  });
  try {
    const wallets = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
    assertEquals(wallets.map((w) => w.currency).sort(), ['BTC', 'USD']);
  } finally {
    restore();
  }
});

Deno.test('discover: external_wallet_id is fresh on each discovery (opaque, not derived)', async () => {
  const stub = {
    balances: [{ currency: 'USD', current: '1.00' }],
    invoiceCurrencies: ['USD'],
    receiverId: 'acct-fresh',
  };

  const restore1 = installFetchStub(stub);
  let idFirst: string;
  try {
    const [w] = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
    idFirst = w.external_wallet_id;
  } finally {
    restore1();
  }

  const restore2 = installFetchStub(stub);
  try {
    const [w] = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
    assert(w.external_wallet_id !== idFirst, 'external_wallet_id must be fresh each discovery');
  } finally {
    restore2();
  }
});
