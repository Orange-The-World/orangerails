import { describe, expect, it, vi } from 'vitest';

import { AlbyConfirmsClient } from './alby';

/** Build N fake settled invoices starting at index `base`. */
function makeInvoices(count: number, base: number = 1) {
  return Array.from({ length: count }, (_, i) => ({
    payment_hash: `hash${base + i}`,
    amount: 1000,
    memo: null,
    settled: true,
    settled_at: 1706745600 + base + i,
    created_at: 1706700000 + base + i,
    expires_at: null,
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

describe('AlbyConfirmsClient.fetchSettled - pagination safety cap', () => {
  it('throws when the backend keeps returning full pages beyond maxPages', async () => {
    // Simulates a backend that ignores the page param: every request
    // returns the same 100-item page, so the loop would spin forever
    // without a cap.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ invoices: makeInvoices(100) }));

    const client = new AlbyConfirmsClient({
      accessToken: 'tok_test',
      apiBase: 'https://test.invalid',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        client.fetchSettled({ maxPages: 2 }),
      ).rejects.toThrow(/pagination safety cap reached after 2 page/);
    } finally {
      globalThis.fetch = origFetch;
    }

    // Must have called fetch exactly maxPages times before throwing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the result set is exhausted within the cap', async () => {
    // Page 1: full (100 items). Page 2: partial (42 items) - signals
    // exhaustion, so we stop before hitting the cap.
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      const count = callCount === 1 ? 100 : 42;
      return jsonResponse({ invoices: makeInvoices(count, (callCount - 1) * 100 + 1) });
    });

    const client = new AlbyConfirmsClient({
      accessToken: 'tok_test',
      apiBase: 'https://test.invalid',
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

  it('paginates to natural exhaustion when maxPages is not set', async () => {
    // Pages 1-2 full (100 items each), page 3 partial (10 items).
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      const count = callCount < 3 ? 100 : 10;
      return jsonResponse({ invoices: makeInvoices(count, (callCount - 1) * 100 + 1) });
    });

    const client = new AlbyConfirmsClient({
      accessToken: 'tok_test',
      apiBase: 'https://test.invalid',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const invoices = await client.fetchSettled();
      expect(invoices).toHaveLength(210);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('throws at the default cap when maxPages is omitted', async () => {
    // Production path: caller passes no maxPages. The DEFAULT_MAX_PAGES (20)
    // must engage so a runaway backend does not spin forever.
    // Backend always returns a full page of 100 items.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ invoices: makeInvoices(100) }));

    const client = new AlbyConfirmsClient({
      accessToken: 'tok_test',
      apiBase: 'https://test.invalid',
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        client.fetchSettled(), // no maxPages: default must apply
      ).rejects.toThrow(/pagination safety cap reached after 20 page/);
    } finally {
      globalThis.fetch = origFetch;
    }

    // Must stop at exactly 20 fetches (the default cap).
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});
