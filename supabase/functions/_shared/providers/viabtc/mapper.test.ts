/**
 * ViaBTC row mapping tests. Fixtures are the wiki response examples
 * (acquire_payment_history, acquire_profit_history, acquire_reward_history).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/viabtc/mapper.test.ts
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  btcToSats,
  mapPayments,
  mapProfitRow,
  mapProfits,
  profitDateToIso,
  unixSecondsToIso,
} from "./mapper.ts";
import { VIABTC_SOURCE_TAG, type ViaBtcPaymentRow, type ViaBtcProfitRow } from "./types.ts";

const PAYMENTS: ViaBtcPaymentRow[] = [
  {
    id: 157,
    coin: "BTC",
    amount: "0.001",
    address: "mtRJjPJGVLGs5YDf4VUP5RQXipzHjnjeCe",
    tx: "eaa0597e556ceda83ffe5d3533a4aba93b49e7dbb2fa35895dd08754fb9d62d0",
    create_time: 1530704756,
  },
  {
    id: 266,
    coin: "BTC",
    amount: "0.001",
    address: "qr0xs7rk2ku4rkg4kpayvcet3pvw7zcceszsaflkzs",
    tx: "00802e7d6acf262c9afda8882dc361c705f224985c074f62e57942af9beae8b9",
    create_time: 1530704757,
  },
];

const PROFITS: ViaBtcProfitRow[] = [
  {
    coin: "BTC",
    date: "2018-10-05",
    pplns_profit: "0",
    pps_profit: "0.00002148",
    solo_profit: "0",
    total_profit: "0.00002148",
  },
  {
    coin: "BTC",
    date: "2018-10-06",
    pplns_profit: "0",
    pps_profit: "0.00028948",
    solo_profit: "0",
    total_profit: "0.00028948",
  },
];

const REWARDS: ViaBtcProfitRow[] = [
  {
    coin: "DOGE",
    date: "2023-04-19",
    pplns_profit: "366.07702259",
    pps_profit: "0",
    solo_profit: "0",
    total_profit: "366.07702259",
  },
];

Deno.test("btcToSats uses integer math on the wiki payment amount", () => {
  assertEquals(btcToSats("0.001"), 100_000);
  assertEquals(btcToSats("0.00002148"), 2148);
  assertEquals(btcToSats("1"), 100_000_000);
});

Deno.test("payment rows become mining_payout events with txid and no vout", () => {
  const rows = mapPayments(PAYMENTS, "wallet-1");
  assertEquals(rows.length, 2);
  const first = rows[0];
  assertEquals(first.type, "mining_payout");
  assertEquals(first.direction, "in");
  assertEquals(first.adapter, "viabtc");
  assertEquals(first.id, "viabtc:payout:157");
  assertEquals(first.amount_sats, 100_000);
  assertEquals(first.currency, "BTC");
  assertEquals(first.txid, PAYMENTS[0].tx);
  assertEquals(first.counterparty, PAYMENTS[0].address);
  assertEquals(first.source_wallet_id, "wallet-1");
  assertEquals(first.source_tag, VIABTC_SOURCE_TAG);
  assertEquals(first.vout, undefined);
  assertEquals(first.from_coinbase, undefined);
  assertEquals(first.timestamp, unixSecondsToIso(1530704756));
});

Deno.test("profit rows become mining_earning events with no txid", () => {
  const rows = mapProfits(PROFITS, "wallet-1", "profit");
  assertEquals(rows.length, 2);
  const first = rows[0];
  assertEquals(first.type, "mining_earning");
  assertEquals(first.id, "viabtc:profit:BTC:2018-10-05");
  assertEquals(first.amount_sats, 2148);
  assertEquals(first.txid, undefined);
  assertEquals(first.timestamp, profitDateToIso("2018-10-05"));
  assertEquals(first.source_tag, VIABTC_SOURCE_TAG);
});

Deno.test("reward rows keep the altcoin on amount+currency, not satoshis", () => {
  const rows = mapProfits(REWARDS, "wallet-1", "reward");
  assertEquals(rows.length, 1);
  const row = rows[0];
  assertEquals(row.type, "mining_earning");
  assertEquals(row.currency, "DOGE");
  assertEquals(row.amount_sats, undefined);
  assertEquals(row.amount, 366.07702259);
  assertEquals(row.id, "viabtc:reward:DOGE:2023-04-19");
});

Deno.test("zero-amount earnings are dropped, not posted as empty value", () => {
  const mapped = mapProfitRow(
    { coin: "BTC", date: "2018-10-05", total_profit: "0.00000000" },
    "wallet-1",
  );
  assertEquals(mapped, null);
});

Deno.test("every mapped row carries source_wallet_id, including null", () => {
  const rows = [...mapPayments(PAYMENTS, null), ...mapProfits(PROFITS, null)];
  assert(rows.length > 0);
  for (const r of rows) {
    assertEquals(r.source_wallet_id, null);
  }
});
