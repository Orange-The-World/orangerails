import { describe, expect, it, vi } from 'vitest';

import { ZeusConfirmsClient } from './zeus';

/**
 * Build N fake settled LND invoices starting at index `base`.
 * LND REST serialises int64 fields as strings, so we match that here.
 */
function makeInvoices(count: number, base: number = 1) {
  return Array.from({ length: count }, (_, i) => ({
    r_hash: `hash${base + i}`,
    memo: null,
    amt_paid_msat: '1000000',
    state: 'SETTLED',
    settled: true,
    creation_date: String(1706700000 + base + i),
    settle_date: String(1706745600 + base + i),
    expiry: '3600',
  }));
}

/** Wrap a raw JSON body in a minimal fetch Response-alike. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  };
}

/**
 * LND advances the cursor via last_index_offset. This mock returns a page of
 * `count` invoices and a last_index_offset that moves forward each call, so
 * the adapter keeps paginating until it sees a short page.
 */
function lndPage(count: number, callCount: number) {
  return jsonResponse({
    invoices: makeInvoices(count, (callCount - 1) * 100 + 1),
    last_index_offset: String(callCount * 100),
  });
}

describe('ZeusConfirmsClient.fetchSettled - pagination safety cap', () => {
  it('throws when the backend keeps returning full pages beyond maxPages', async () => {
    // Backend ignores index_offset but still advances last_index_offset:
    // every request returns a full 100-item page, so only the cap stops it.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return lndPage(100, callCount);
    });

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(client.fetchSettled({ maxPages: 2 })).rejects.toThrow(
        /pagination safety cap reached after 2 page/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not throw when the result set is exhausted within the cap', async () => {
    // Page 1 full (100), page 2 partial (42) -> exhaustion before the cap.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return lndPage(callCount === 1 ? 100 : 42, callCount);
    });

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled({ maxPages: 5 });
      expect(invoices).toHaveLength(142);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('stops when the cursor fails to advance instead of looping forever', async () => {
    // Full page every time but last_index_offset never moves: the adapter
    // must treat a non-advancing cursor as exhaustion, not spin.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ invoices: makeInvoices(100), last_index_offset: '0' }),
    );

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled();
      expect(invoices).toHaveLength(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('ZeusConfirmsClient.fetchSettled - invariants', () => {
  it('filters the after-cursor on settle time, not creation time', async () => {
    // One invoice created BEFORE the cursor but settled AFTER it must be
    // returned; one settled before the cursor must be dropped.
    const before = {
      r_hash: 'settled_before',
      memo: null,
      amt_paid_msat: '1000000',
      state: 'SETTLED',
      settled: true,
      creation_date: String(1706700000),
      settle_date: String(1706700100), // settled early
      expiry: '3600',
    };
    const lateSettle = {
      r_hash: 'settled_after',
      memo: null,
      amt_paid_msat: '1000000',
      state: 'SETTLED',
      settled: true,
      creation_date: String(1706700000), // created early, same as `before`
      settle_date: String(1706800000), // settled late
      expiry: '3600',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ invoices: [before, lateSettle], last_index_offset: '2' }));

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const cursor = new Date(1706750000 * 1000).toISOString();
      const invoices = await client.fetchSettled({ after: cursor });
      expect(invoices.map((i) => i.payment_hash)).toEqual(['settled_after']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('reads the native millisatoshi field without converting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        invoices: [
          {
            r_hash: 'msat_native',
            memo: null,
            amt_paid_msat: '2500', // not a whole-sat multiple: proves no *1000
            state: 'SETTLED',
            settled: true,
            creation_date: String(1706700000),
            settle_date: String(1706745600),
            expiry: '3600',
          },
        ],
        last_index_offset: '1',
      }),
    );

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled();
      expect(invoices[0].amount_msat).toBe(2500);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('falls back to the satoshi field when no msat field is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        invoices: [
          {
            r_hash: 'sat_fallback',
            memo: null,
            amt_paid_sat: '3', // 3 sats -> 3000 msat
            state: 'SETTLED',
            settled: true,
            creation_date: String(1706700000),
            settle_date: String(1706745600),
            expiry: '3600',
          },
        ],
        last_index_offset: '1',
      }),
    );

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled();
      expect(invoices[0].amount_msat).toBe(3000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drops unsettled rows before they reach the pipeline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        invoices: [
          { r_hash: 'open', state: 'OPEN', settled: false, amt_paid_msat: '0', creation_date: '1706700000', settle_date: '0', expiry: '3600' },
          { r_hash: 'settled', state: 'SETTLED', settled: true, amt_paid_msat: '1000', creation_date: '1706700000', settle_date: '1706745600', expiry: '3600' },
        ],
        last_index_offset: '2',
      }),
    );

    const client = new ZeusConfirmsClient({
      apiBase: 'https://test.invalid',
      macaroon: 'mac_test',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled();
      expect(invoices.map((i) => i.payment_hash)).toEqual(['settled']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
