import { describe, expect, it } from "vitest";

import { StrikeApiClient, invoiceToTransaction, payoutToTransaction, paginateOData } from "./api";
import { StrikeApiUnavailableError } from "./types";

/** Build a fake fetch that returns the configured (status, body) per path. */
function mockFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(routes).find((p) => url.includes(p));
    if (!match) {
      return new Response("not mocked", { status: 404 }) as Response;
    }
    const { status, body } = routes[match]!;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }) as Response;
  }) as unknown as typeof fetch;
}

describe("StrikeApiClient.healthCheck", () => {
  it("returns ok=true on 200", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({ "/balances": { status: 200, body: [] } }),
    });
    expect(await client.healthCheck()).toEqual({ ok: true });
  });

  it("returns ok=false with status on 401", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({ "/balances": { status: 401, body: { error: "unauth" } } }),
    });
    const res = await client.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });

  it("returns ok=false when fetch throws", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const res = await client.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network down");
  });

  it("does not leak the bearer token in error messages", async () => {
    const client = new StrikeApiClient({
      apiKey: "super-secret-key",
      fetchImpl: mockFetch({ "/balances": { status: 500, body: {} } }),
    });
    const res = await client.healthCheck();
    expect(JSON.stringify(res)).not.toContain("super-secret-key");
  });
});

describe("StrikeApiClient.fetchAccounts", () => {
  it("maps each balance currency to a synthesized account", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({
        "/balances": {
          status: 200,
          body: [
            { currency: "BTC", available: "0.10000000", current: "0.10000000" },
            { currency: "USD", available: "42.50", current: "42.50" },
          ],
        },
      }),
    });
    const accounts = await client.fetchAccounts();
    expect(accounts).toEqual([
      { id: "strike:BTC", currency: "BTC", balance: "0.10000000" },
      { id: "strike:USD", currency: "USD", balance: "42.50" },
    ]);
  });

  it("throws StrikeApiUnavailableError on non-200", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({ "/balances": { status: 403, body: {} } }),
    });
    await expect(client.fetchAccounts()).rejects.toBeInstanceOf(StrikeApiUnavailableError);
  });
});

describe("StrikeApiClient.fetchTransactions", () => {
  it("merges paid invoices + completed payouts, sorted by occurredAt", async () => {
    const invoice = {
      invoiceId: "inv-1",
      amount: { amount: "0.0005", currency: "BTC" },
      state: "PAID",
      created: "2026-04-01T10:00:00Z",
      transactions: [
        { transactionId: "t1", state: "COMPLETED", completed: "2026-04-01T10:05:00Z" },
      ],
    };
    const payout = {
      id: "po-1",
      state: "COMPLETED",
      created: "2026-04-02T08:00:00Z",
      completed: "2026-04-02T08:30:00Z",
      amount: { amount: "100", currency: "USD" },
    };
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({
        "/invoices": { status: 200, body: { items: [invoice], count: 1 } },
        "/payouts": { status: 200, body: { items: [payout], count: 1 } },
      }),
    });
    const txs = await client.fetchTransactions({});
    expect(txs).toHaveLength(2);
    expect(txs[0]!.direction).toBe("Receive");
    expect(txs[0]!.id).toBe("inv-1");
    expect(txs[1]!.direction).toBe("Send");
    expect(txs[1]!.id).toBe("po-1");
  });

  it("filters out non-PAID invoices and non-COMPLETED payouts", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({
        "/invoices": {
          status: 200,
          body: {
            items: [
              {
                invoiceId: "u1",
                amount: { amount: "1", currency: "USD" },
                state: "UNPAID",
                created: "2026-04-01T10:00:00Z",
              },
            ],
          },
        },
        "/payouts": {
          status: 200,
          body: {
            items: [
              {
                id: "f1",
                state: "FAILED",
                created: "2026-04-02T10:00:00Z",
                amount: { amount: "1", currency: "USD" },
              },
            ],
          },
        },
      }),
    });
    expect(await client.fetchTransactions({})).toEqual([]);
  });

  it("surfaces a 500 from /invoices as StrikeApiUnavailableError", async () => {
    const client = new StrikeApiClient({
      apiKey: "k",
      fetchImpl: mockFetch({
        "/invoices": { status: 500, body: {} },
        "/payouts": { status: 200, body: { items: [] } },
      }),
    });
    await expect(client.fetchTransactions({})).rejects.toBeInstanceOf(StrikeApiUnavailableError);
  });
});

describe("paginateOData", () => {
  it("stops when a page returns fewer than the page size", async () => {
    const calls: Array<{ skip: number; top: number }> = [];
    const items = await paginateOData<number>(async (skip, top) => {
      calls.push({ skip, top });
      // Single short page → loop should exit after one call.
      return { items: [1, 2, 3], count: 3 };
    });
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
  });

  it("loops until a short page", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => i),
      Array.from({ length: 100 }, (_, i) => 100 + i),
      Array.from({ length: 7 }, (_, i) => 200 + i),
    ];
    let n = 0;
    const items = await paginateOData<number>(async () => ({ items: pages[n++]!, count: 207 }));
    expect(items).toHaveLength(207);
    expect(items[0]).toBe(0);
    expect(items[206]).toBe(206);
  });
});

describe("pure mappers", () => {
  it("invoiceToTransaction uses transaction.completed when present", () => {
    const t = invoiceToTransaction({
      invoiceId: "i1",
      amount: { amount: "0.5", currency: "BTC" },
      state: "PAID",
      created: "2026-01-01T00:00:00Z",
      transactions: [{ transactionId: "x", state: "COMPLETED", completed: "2026-01-01T00:05:00Z" }],
    });
    expect(t.occurredAt).toBe("2026-01-01T00:05:00Z");
    expect(t.direction).toBe("Receive");
  });

  it("payoutToTransaction carries the fee amount", () => {
    const t = payoutToTransaction({
      id: "p1",
      state: "COMPLETED",
      created: "2026-01-01T00:00:00Z",
      completed: "2026-01-01T00:10:00Z",
      amount: { amount: "100", currency: "USD" },
      fee: { amount: "0.50", currency: "USD" },
    });
    expect(t.direction).toBe("Send");
    expect(t.fee).toBe("0.50");
  });
});
