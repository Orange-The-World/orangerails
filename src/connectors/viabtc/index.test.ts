import { describe, expect, it } from "vitest";

import { hmacSha256Hex } from "./sign";
import { ingestViaBtc } from "./index";
import { ViaBtcAuthError } from "./types";

const API_KEY = "16289e05354c3c3814b8f3045950395f";
const SECRET = "d186ababcb0eb1f6af5c1519424f462b84c631f86c06309992ae1f15604668b0";
const FIXED_NOW = 1_513_746_038_205;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(opts: {
  secret: string;
  nowMs: number;
  payments?: unknown[];
  profits?: unknown[];
  rewards?: Record<string, unknown[]>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    const query = parsed.search.replace(/^\?/, "");
    const headers = new Headers(init?.headers);
    const sentKey = headers.get("X-API-KEY") ?? "";
    const sentSig = headers.get("X-SIGNATURE") ?? "";

    if (sentKey !== API_KEY) {
      return json({ code: 12001, message: "Invalid API key" });
    }
    const expected = hmacSha256Hex(opts.secret, query);
    if (sentSig !== expected) {
      return json({ code: 12002, message: "Signature error" });
    }
    const tonce = Number(parsed.searchParams.get("tonce"));
    const matchesInjected = Number.isFinite(tonce) && Math.abs(tonce - opts.nowMs) <= 60_000;
    const matchesWall = Number.isFinite(tonce) && Math.abs(tonce - Date.now()) <= 60_000;
    if (!matchesInjected && !matchesWall) {
      return json({ code: 12003, message: "Invalid tonce" });
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    if (path.endsWith("/account/sub")) {
      return json({ code: 0, data: [], has_next: false, message: "OK" });
    }
    if (path.endsWith("/account")) {
      return json({
        code: 0,
        data: {
          account: { id: 45, account: "test" },
          balance: [{ coin: "BTC", amount: "0.001" }],
        },
        message: "OK",
      });
    }
    if (path.endsWith("/wallet/payment/history")) {
      return json({
        code: 0,
        data: opts.payments ?? [],
        has_next: false,
        message: "OK",
      });
    }
    if (path.endsWith("/profit/history")) {
      return json({
        code: 0,
        data: { data: opts.profits ?? [], has_next: false },
        message: "OK",
      });
    }
    if (path.endsWith("/reward/history")) {
      const coin = parsed.searchParams.get("coin") ?? "";
      const rows = opts.rewards?.[coin];
      if (!rows) return json({ code: 5001, message: "Invalid coin type" });
      return json({ code: 0, data: { data: rows, has_next: false }, message: "OK" });
    }
    return json({ code: 2, message: "Invalid argument" });
  }) as unknown as typeof fetch;
}

describe("ingestViaBtc", () => {
  it("wrong secret throws ViaBtcAuthError and does not emit rows", async () => {
    await expect(
      ingestViaBtc({
        apiKey: API_KEY,
        secretKey: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        fetchImpl: mockFetch({ secret: SECRET, nowMs: FIXED_NOW }),
        nowMs: () => FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(ViaBtcAuthError);
  });

  it("stale tonce throws ViaBtcAuthError and does not emit rows", async () => {
    await expect(
      ingestViaBtc({
        apiKey: API_KEY,
        secretKey: SECRET,
        fetchImpl: mockFetch({ secret: SECRET, nowMs: FIXED_NOW }),
        nowMs: () => 1,
      }),
    ).rejects.toBeInstanceOf(ViaBtcAuthError);
  });

  it("a valid empty account returns zero journal lines, not an error", async () => {
    const res = await ingestViaBtc({
      apiKey: API_KEY,
      secretKey: SECRET,
      fetchImpl: mockFetch({ secret: SECRET, nowMs: FIXED_NOW }),
      nowMs: () => FIXED_NOW,
    });
    expect(res.payload.source.name).toBe("viabtc");
    expect(res.payload.summary.journalLines).toBe(0);
    expect(res.payload.summary.errors).toEqual([]);
    expect(res.history.payments).toEqual([]);
  });

  it("maps wiki payment and profit amounts onto staged journal lines", async () => {
    const res = await ingestViaBtc({
      apiKey: API_KEY,
      secretKey: SECRET,
      fetchImpl: mockFetch({
        secret: SECRET,
        nowMs: FIXED_NOW,
        payments: [
          {
            id: 157,
            coin: "BTC",
            amount: "0.001",
            address: "mtRJjPJGVLGs5YDf4VUP5RQXipzHjnjeCe",
            tx: "eaa0597e556ceda83ffe5d3533a4aba93b49e7dbb2fa35895dd08754fb9d62d0",
            create_time: 1530704756,
          },
        ],
        profits: [{ coin: "BTC", date: "2018-10-05", total_profit: "0.00002148" }],
        rewards: {
          DOGE: [{ coin: "DOGE", date: "2023-04-19", total_profit: "366.07702259" }],
        },
      }),
      nowMs: () => FIXED_NOW,
    });
    expect(res.payload.summary.journalLines).toBe(3);
    const lines = res.payload.staged.journalEntries ?? [];
    expect(lines.map((l) => l.debit).sort()).toEqual(["0.00002148", "0.001", "366.07702259"]);
  });

  it("does not put the secret in the thrown message", async () => {
    try {
      await ingestViaBtc({
        apiKey: API_KEY,
        secretKey: SECRET + "x",
        fetchImpl: mockFetch({ secret: SECRET, nowMs: FIXED_NOW }),
        nowMs: () => FIXED_NOW,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
      expect(JSON.stringify(err)).not.toContain(SECRET);
    }
  });
});
