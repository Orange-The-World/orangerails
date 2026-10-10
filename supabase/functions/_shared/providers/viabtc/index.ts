/**
 * ViaBTC pool source adapter.
 *
 * Credentials: api_key + secret_key, sealed like any exchange key (DL-1269).
 * Events: mining_earning (profit/reward history) and mining_payout (payment
 * history), source_tag viabtc.api.v1 (DL-1896).
 *
 * Auth failures (wiki codes 12001-12004, HTTP 401/403, signature/tonce
 * mismatch) throw ViaBtcAuthError. They are never returned as zero rows.
 */

import type { DiscoveredWallet, ProviderAdapter, SyncResult } from "../types.ts";
import { ViaBtcClient, coinsFromAccount } from "./client.ts";
import { mapPayments, mapProfits } from "./mapper.ts";
import {
  VIABTC_REWARD_COINS,
  ViaBtcApiError,
  ViaBtcAuthError,
  parseViaBtcCredentials,
} from "./types.ts";

function clientFrom(credentials: Record<string, unknown>): ViaBtcClient {
  return new ViaBtcClient({ credentials: parseViaBtcCredentials(credentials) });
}

function cursorToStartDate(cursor: string | null): string | undefined {
  if (!cursor) return undefined;
  const day = cursor.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return day;
}

function isoDay(ts: string): string {
  return ts.slice(0, 10);
}

async function discover(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  const client = clientFrom(credentials);
  await client.probeAuth();
  const info = await client.fetchAccount();
  const accountId = info.account?.id;
  const accountName = info.account?.account;
  return [
    {
      external_wallet_id: crypto.randomUUID(),
      currency: "BTC",
      label: accountName ? `ViaBTC ${accountName}` : "ViaBTC pool",
      ...(accountId !== undefined && accountId !== null ? { account_key: String(accountId) } : {}),
    },
  ];
}

async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  const client = clientFrom(credentials);
  await client.probeAuth();
  const info = await client.fetchAccount();
  const coins = coinsFromAccount(info);
  const sourceWalletId = walletIds[0] ?? null;
  const startDate = cursorToStartDate(cursor);

  const transactions = [];

  for (const coin of coins) {
    const [payments, profits] = await Promise.all([
      client.fetchPaymentHistory({ coin, startDate }),
      client.fetchProfitHistory({ coin, startDate }),
    ]);
    transactions.push(...mapPayments(payments, sourceWalletId));
    transactions.push(...mapProfits(profits, sourceWalletId, "profit"));
  }

  for (const coin of VIABTC_REWARD_COINS) {
    try {
      const rewards = await client.fetchRewardHistory({ coin, startDate });
      transactions.push(...mapProfits(rewards, sourceWalletId, "reward"));
    } catch (err) {
      if (err instanceof ViaBtcAuthError) throw err;
      // 5001 = invalid coin type. Reward history is documented only for
      // NMC/DOGE/SYS/ELA; a BTC-only account hitting 5001 is not a failure.
      if (err instanceof ViaBtcApiError && err.viabtcCode === 5001) continue;
      throw err;
    }
  }

  transactions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  let maxDay = startDate ?? "";
  for (const tx of transactions) {
    const day = isoDay(tx.timestamp);
    if (day > maxDay) maxDay = day;
  }

  return {
    transactions,
    next_cursor: maxDay || null,
  };
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  cursor: string | null,
): Promise<SyncResult> {
  return syncByWallets(credentials, [], cursor);
}

export const viabtcAdapter: ProviderAdapter = {
  slug: "viabtc",
  displayName: "ViaBTC Pool",
  description: "Mining rewards and payouts",
  status: "beta",
  category: "mining",
  tags: ["mining", "pool", "payouts", "custodial"],
  custody: "custodial",
  popularity: 70,
  multiWallet: false,
  credentialFields: [
    {
      name: "api_key",
      type: "secret",
      label: "ViaBTC API key",
      placeholder: "From Account Settings → API",
      helpLabel: "Generate a key at viabtc.com/setting/api",
      helpHref: "https://www.viabtc.com/setting/api",
    },
    {
      name: "secret_key",
      type: "secret",
      label: "ViaBTC secret key",
      placeholder: "Shown once when the API key is created",
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};

export { ViaBtcClient } from "./client.ts";
export { ViaBtcAuthError, ViaBtcApiError, VIABTC_SOURCE_TAG } from "./types.ts";
export { mapPaymentRow, mapProfitRow, btcToSats } from "./mapper.ts";
