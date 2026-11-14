/**
 * ViaBTC client tests. The mock verifies X-SIGNATURE against the query
 * string the way the pool does, so a wrong secret and a stale tonce fail
 * as auth errors rather than as empty lists.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/viabtc/client.test.ts
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyUpstreamError } from "../../upstream-errors.ts";
import { ViaBtcClient } from "./client.ts";
import { hmacSha256Hex } from "./sign.ts";
import { ViaBtcAuthError, ViaBtcApiError } from "./types.ts";
import { viabtcAdapter } from "./index.ts";

const API_KEY = "16289e05354c3c3814b8f3045950395f";
const SECRET = "d186ababcb0eb1f6af5c1519424f462b84c631f86c06309992ae1f15604668b0";
const FIXED_NOW = 1_513_746_038_205;

type Store = {
  payments: unknown[];
  profits: unknown[];
  rewards: Record<string, unknown[]>;
  account: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installMock(opts: {
  secret: string;
  nowMs: number;
  store?: Partial<Store>;
  leak?: string;
}): () => void {
  const original = globalThis.fetch;
  const store: Store = {
    payments: opts.store?.payments ?? [],
    profits: opts.store?.profits ?? [],
    rewards: opts.store?.rewards ?? {},
    account: opts.store?.account ?? {
      account: { id: 45, account: "test" },
      withdraw_address: [{ coin: "BTC", address: "mtRJjPJGVLGs5YDf4VUP5RQXipzHjnjeCe" }],
      balance: [{ coin: "BTC", amount: "0.001" }],
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    const query = parsed.search.replace(/^\?/, "");
    const headers = new Headers(init?.headers);
    const sentKey = headers.get("X-API-KEY") ?? "";
    const sentSig = headers.get("X-SIGNATURE") ?? "";

    if (opts.leak && (sentKey.includes(opts.leak) || sentSig.includes(opts.leak) || url.includes(opts.leak))) {
      // Reachable only if a test put a secret in the URL. The assertions
      // below check error messages, not this branch.
    }

    if (sentKey !== API_KEY) {
      return json({ code: 12001, message: "Invalid API key" });
    }
    const expected = await hmacSha256Hex(opts.secret, query);
    if (sentSig !== expected) {
      return json({ code: 12002, message: "Signature error" });
    }
    const tonce = Number(parsed.searchParams.get("tonce"));
    const matchesInjectedClock = Number.isFinite(tonce) && Math.abs(tonce - opts.nowMs) <= 60_000;
    const matchesWallClock = Number.isFinite(tonce) && Math.abs(tonce - Date.now()) <= 60_000;
    if (!matchesInjectedClock && !matchesWallClock) {
      return json({ code: 12003, message: "Invalid tonce" });
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    if (path.endsWith("/account/sub")) {
      return json({ code: 0, data: [], has_next: false, message: "OK" });
    }
    if (path.endsWith("/account")) {
      return json({ code: 0, data: store.account, message: "OK" });
    }
    if (path.endsWith("/wallet/payment/history")) {
      return json({
        code: 0,
        data: store.payments,
        has_next: false,
        total: store.payments.length,
        message: "OK",
      });
    }
    if (path.endsWith("/profit/history")) {
      return json({
        code: 0,
        data: { data: store.profits, has_next: false, total: store.profits.length },
        message: "OK",
      });
    }
    if (path.endsWith("/reward/history")) {
      const coin = parsed.searchParams.get("coin") ?? "";
      const rows = store.rewards[coin];
      if (!rows) return json({ code: 5001, message: "Invalid coin type" });
      return json({
        code: 0,
        data: { data: rows, has_next: false, total: rows.length },
        message: "OK",
      });
    }
    if (path.endsWith("/profit")) {
      return json({
        code: 0,
        data: { coin: "BTC", total_profit: "0.00002148", pplns_profit: "0", pps_profit: "0.00002148", solo_profit: "0" },
        message: "OK",
      });
    }
    return json({ code: 2, message: "Invalid argument" });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

function client(overrides?: { secret?: string; nowMs?: number }): ViaBtcClient {
  return new ViaBtcClient({
    credentials: { api_key: API_KEY, secret_key: overrides?.secret ?? SECRET },
    nowMs: () => overrides?.nowMs ?? FIXED_NOW,
  });
}

Deno.test("valid credentials with empty history return an empty list, not an error", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const c = client();
    await c.probeAuth();
    const payments = await c.fetchPaymentHistory({ coin: "BTC" });
    const profits = await c.fetchProfitHistory({ coin: "BTC" });
    assertEquals(payments, []);
    assertEquals(profits, []);
  } finally {
    restore();
  }
});

Deno.test("wrong secret throws ViaBtcAuthError and writes no rows", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const c = client({ secret: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" });
    const err = await assertRejects(() => c.probeAuth(), ViaBtcAuthError);
    assertEquals(err.upstreamCode, "UPSTREAM_AUTH_FAILED");
    assertEquals(err.viabtcCode, 12002);
    assertEquals(classifyUpstreamError(err.message), "UPSTREAM_AUTH_FAILED");
    assertEquals(err.message.includes("ffffffffffffffff"), false);
  } finally {
    restore();
  }
});

Deno.test("stale tonce throws ViaBtcAuthError and writes no rows", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const c = client({ nowMs: 1 }); // 1970, far outside the 60s window
    const err = await assertRejects(() => c.probeAuth(), ViaBtcAuthError);
    assertEquals(err.viabtcCode, 12003);
    assertEquals(classifyUpstreamError(err.message), "UPSTREAM_AUTH_FAILED");
    assert(err.message.toLowerCase().includes("tonce") || err.message.toLowerCase().includes("unauthorized"));
  } finally {
    restore();
  }
});

Deno.test("wrong api key throws ViaBtcAuthError (12001)", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const c = new ViaBtcClient({
      credentials: { api_key: "not-the-key", secret_key: SECRET },
      nowMs: () => FIXED_NOW,
    });
    const err = await assertRejects(() => c.probeAuth(), ViaBtcAuthError);
    assertEquals(err.viabtcCode, 12001);
    assertEquals(classifyUpstreamError(err.message), "UPSTREAM_AUTH_FAILED");
  } finally {
    restore();
  }
});

Deno.test("sync with a wrong secret does not return an empty success", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    await assertRejects(
      () =>
        viabtcAdapter.syncAccountWide(
          { api_key: API_KEY, secret_key: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
          null,
        ),
      ViaBtcAuthError,
    );
  } finally {
    restore();
  }
});

Deno.test("sync of a valid empty account returns zero rows without throwing", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const result = await viabtcAdapter.syncAccountWide(
      { api_key: API_KEY, secret_key: SECRET },
      null,
    );
    assertEquals(result.transactions, []);
  } finally {
    restore();
  }
});

Deno.test("sync maps wiki payment + profit + reward rows line for line", async () => {
  const restore = installMock({
    secret: SECRET,
    nowMs: FIXED_NOW,
    store: {
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
      profits: [
        {
          coin: "BTC",
          date: "2018-10-05",
          total_profit: "0.00002148",
          pplns_profit: "0",
          pps_profit: "0.00002148",
          solo_profit: "0",
        },
      ],
      rewards: {
        DOGE: [
          {
            coin: "DOGE",
            date: "2023-04-19",
            total_profit: "366.07702259",
            pplns_profit: "366.07702259",
            pps_profit: "0",
            solo_profit: "0",
          },
        ],
      },
    },
  });
  try {
    const result = await viabtcAdapter.syncAccountWide(
      { api_key: API_KEY, secret_key: SECRET },
      null,
    );
    const payouts = result.transactions.filter((t) => t.type === "mining_payout");
    const earnings = result.transactions.filter((t) => t.type === "mining_earning");
    assertEquals(payouts.length, 1);
    assertEquals(payouts[0].amount_sats, 100_000);
    assertEquals(payouts[0].txid, "eaa0597e556ceda83ffe5d3533a4aba93b49e7dbb2fa35895dd08754fb9d62d0");
    assertEquals(earnings.length, 2);
    const btcEarn = earnings.find((e) => e.currency === "BTC");
    const dogeEarn = earnings.find((e) => e.currency === "DOGE");
    assertEquals(btcEarn?.amount_sats, 2148);
    assertEquals(dogeEarn?.amount, 366.07702259);
  } finally {
    restore();
  }
});

Deno.test("discover probes auth before returning a wallet", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    const wallets = await viabtcAdapter.discoverWallets({ api_key: API_KEY, secret_key: SECRET });
    assertEquals(wallets.length, 1);
    assertEquals(wallets[0].currency, "BTC");
    assertEquals(wallets[0].account_key, "45");
  } finally {
    restore();
  }
});

Deno.test("discover with a wrong secret throws, it does not invent a wallet", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW });
  try {
    await assertRejects(
      () => viabtcAdapter.discoverWallets({ api_key: API_KEY, secret_key: "nope" }),
      ViaBtcAuthError,
    );
  } finally {
    restore();
  }
});

Deno.test("error messages never echo the secret key", async () => {
  const restore = installMock({ secret: SECRET, nowMs: FIXED_NOW, leak: SECRET });
  try {
    const err = await assertRejects(
      () => viabtcAdapter.syncAccountWide({ api_key: API_KEY, secret_key: SECRET + "x" }, null),
      Error,
    );
    assertEquals(JSON.stringify(err).includes(SECRET), false);
    assertEquals(err.message.includes(SECRET), false);
  } finally {
    restore();
  }
});

Deno.test("missing credentials throw a config error, not an empty sync", async () => {
  await assertRejects(
    () => viabtcAdapter.syncAccountWide({ api_key: API_KEY }, null),
    Error,
    "credentials.secret_key required",
  );
});

Deno.test("code 2 (invalid argument) is an API error, not an empty list", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json({ code: 2, message: "Invalid argument" })) as typeof fetch;
  try {
    const c = client();
    await assertRejects(() => c.probeAuth(), ViaBtcApiError);
  } finally {
    globalThis.fetch = original;
  }
});
