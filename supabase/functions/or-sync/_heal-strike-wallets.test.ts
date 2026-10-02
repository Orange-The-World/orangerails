/**
 * Unit tests for the DL-1398 Strike wallet heal path in or-sync.
 *
 * The heal block (or-sync/index.ts, DL-1398 comment) runs on every Strike
 * sync. It calls adapter.discoverWallets(credentials), computes a
 * wallet_fingerprint for each discovered wallet, and inserts any wallet not
 * already in source_wallets. This is the fix for OR-T0356: 8 pre-2026-07-20
 * Strike connections each have only one source_wallets row with the legacy
 * external_wallet_id='strike' slug and wallet_fingerprint=NULL, because the
 * original upsert used ON CONFLICT (connection_id, external_wallet_id) and
 * the slug collision caused the second currency account to silently overwrite
 * the first.
 *
 * These tests do NOT require a running Supabase instance. They use the same
 * building blocks the heal block uses (strikeAdapter.discoverWallets,
 * computeWalletFingerprint, toByteaHex) and replicate the heal loop inline.
 *
 * Run:
 *   OR_ACCT_FINGERPRINT_KEY_V1=<64-hex-chars> \
 *     deno test supabase/functions/or-sync/_heal-strike-wallets.test.ts \
 *     --allow-env
 *
 * The tests set the env variable themselves to a deterministic test value so
 * they are self-contained and offline.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { strikeAdapter } from '../_shared/providers/strike/index.ts';
import { computeWalletFingerprint } from '../_shared/account-fingerprint.ts';
import { toByteaHex } from '../_shared/bytea.ts';

// --- Test helpers -----------------------------------------------------------

// 32 bytes (256 bits) of deterministic test key material.
// This is NOT a production key; it is used only in these tests.
const TEST_FINGERPRINT_KEY =
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

function setTestFingerprintKey(): void {
  Deno.env.set('OR_ACCT_FINGERPRINT_KEY_V1', TEST_FINGERPRINT_KEY);
}

interface StrikeStub {
  balances: Array<{ currency: string; current: string }>;
  invoiceCurrencies?: string[];
  receiverId: string;
}

function installFetchStub(s: StrikeStub): () => void {
  const orig = globalThis.fetch;
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/balances')) return Promise.resolve(json(s.balances));
    if (url.includes('/invoices?$top=3')) {
      return Promise.resolve(
        json({
          items: [0, 1, 2].map(() => ({
            receiverId: s.receiverId,
            amount: { amount: '1.00', currency: s.balances[0].currency },
          })),
        }),
      );
    }
    if (url.includes('/invoices?$top=100')) {
      const currencies = s.invoiceCurrencies ?? s.balances.map((b) => b.currency);
      return Promise.resolve(
        json({
          items: currencies.map((c) => ({
            receiverId: s.receiverId,
            amount: { amount: '1.00', currency: c },
          })),
        }),
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = orig;
  };
}

/**
 * Replicate the heal loop from or-sync/index.ts (DL-1398 block).
 *
 * existingFingerprintHexSet: the wallet_fingerprint values already in
 *   source_wallets for this connection (NULL rows are excluded, matching the
 *   .filter(w => !!w.wallet_fingerprint) in or-sync).
 */
async function runHealLoop(
  subaccountId: string,
  connectionId: string,
  existingFingerprintHexSet: Set<string>,
): Promise<Array<{
  connection_id: string;
  external_wallet_id: string;
  is_synced: boolean;
  wallet_fingerprint: string;
  wallet_fingerprint_key_version: number;
  discovery_source: string;
}>> {
  const discovered = await strikeAdapter.discoverWallets({ api_key: 'sk-test' });
  const toHeal = [];

  for (const w of discovered) {
    const accountKey = (w as { account_key?: string }).account_key;
    if (!accountKey || !w.currency) continue;

    const mac = await computeWalletFingerprint(subaccountId, 'strike', accountKey, w.currency);
    const fpHex = toByteaHex(mac);

    if (existingFingerprintHexSet.has(fpHex)) continue;

    toHeal.push({
      connection_id: connectionId,
      external_wallet_id: crypto.randomUUID(),
      is_synced: true,
      wallet_fingerprint: fpHex,
      wallet_fingerprint_key_version: 1,
      discovery_source: 'server',
    });
  }

  return toHeal;
}

// --- Tests ------------------------------------------------------------------

Deno.test('heal: BTC+USD legacy account heals to two server-discovered rows', async () => {
  setTestFingerprintKey();
  const restore = installFetchStub({
    balances: [
      { currency: 'BTC', current: '0.001' },
      { currency: 'USD', current: '50.00' },
    ],
    receiverId: 'receiver-btc-usd',
  });
  try {
    // Legacy state: one slug wallet with no fingerprint, so set is empty.
    const toHeal = await runHealLoop('sub-001', 'conn-legacy-btcusd', new Set());

    assertEquals(toHeal.length, 2, 'two new rows for BTC and USD');
    const currencies = await Promise.all(
      toHeal.map(async (row) => {
        // Verify each fingerprint is deterministic and matches a known currency.
        const btcMac = await computeWalletFingerprint('sub-001', 'strike', 'receiver-btc-usd', 'BTC');
        const usdMac = await computeWalletFingerprint('sub-001', 'strike', 'receiver-btc-usd', 'USD');
        if (row.wallet_fingerprint === toByteaHex(btcMac)) return 'BTC';
        if (row.wallet_fingerprint === toByteaHex(usdMac)) return 'USD';
        return 'UNKNOWN';
      }),
    );
    assertEquals(currencies.sort(), ['BTC', 'USD'], 'healed rows map to BTC and USD');

    for (const row of toHeal) {
      assertEquals(row.discovery_source, 'server');
      assertEquals(row.is_synced, true);
      assert(!!row.wallet_fingerprint, 'fingerprint must be set');
      assert(row.external_wallet_id !== 'strike', 'new row must not reuse legacy slug');
    }
  } finally {
    restore();
  }
});

Deno.test('heal: USD-only account heals to exactly one row, not two', async () => {
  setTestFingerprintKey();
  const restore = installFetchStub({
    balances: [{ currency: 'USD', current: '200.00' }],
    receiverId: 'receiver-usd-only',
  });
  try {
    const toHeal = await runHealLoop('sub-002', 'conn-legacy-usd', new Set());

    assertEquals(toHeal.length, 1, 'exactly one wallet for a USD-only account');
    assertEquals(toHeal[0].discovery_source, 'server');
    assertEquals(toHeal[0].is_synced, true);
  } finally {
    restore();
  }
});

Deno.test('heal: idempotent -- already-healed fingerprints are not re-inserted', async () => {
  setTestFingerprintKey();
  const restore = installFetchStub({
    balances: [
      { currency: 'BTC', current: '0.01' },
      { currency: 'USD', current: '100.00' },
    ],
    receiverId: 'receiver-idem',
  });
  try {
    // First heal: empty set, produces 2 rows.
    const firstHeal = await runHealLoop('sub-003', 'conn-idem', new Set());
    assertEquals(firstHeal.length, 2);

    // Second heal: fingerprints from first heal are now in the DB.
    const existingAfterFirst = new Set(firstHeal.map((r) => r.wallet_fingerprint));
    const secondHeal = await runHealLoop('sub-003', 'conn-idem', existingAfterFirst);

    assertEquals(secondHeal.length, 0, 'idempotent: no new rows when fingerprints already exist');
  } finally {
    restore();
  }
});

Deno.test('heal: fingerprints are deterministic for the same inputs', async () => {
  setTestFingerprintKey();
  const restore = installFetchStub({
    balances: [{ currency: 'BTC', current: '0.5' }],
    receiverId: 'receiver-det',
  });
  try {
    const first = await runHealLoop('sub-004', 'conn-det', new Set());
    const second = await runHealLoop('sub-004', 'conn-det', new Set());

    assertEquals(first.length, 1);
    assertEquals(second.length, 1);
    assertEquals(
      first[0].wallet_fingerprint,
      second[0].wallet_fingerprint,
      'same inputs produce the same fingerprint',
    );
    // external_wallet_id is a fresh random UUID each run (not fingerprint-derived)
    assert(
      first[0].external_wallet_id !== second[0].external_wallet_id,
      'external_wallet_id is fresh each discovery (UUID, not derived)',
    );
  } finally {
    restore();
  }
});

Deno.test('heal: currency is uppercased in fingerprint (case-insensitive matching)', async () => {
  setTestFingerprintKey();
  const restore = installFetchStub({
    balances: [{ currency: 'btc', current: '0.1' }],  // lowercase from upstream
    receiverId: 'receiver-case',
  });
  try {
    const toHeal = await runHealLoop('sub-005', 'conn-case', new Set());
    assertEquals(toHeal.length, 1);

    // The fingerprint must match the uppercase version (computeWalletFingerprint
    // normalizes currency to uppercase internally).
    const expectedMac = await computeWalletFingerprint('sub-005', 'strike', 'receiver-case', 'BTC');
    assertEquals(toHeal[0].wallet_fingerprint, toByteaHex(expectedMac));
  } finally {
    restore();
  }
});
