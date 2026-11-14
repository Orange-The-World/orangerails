import { describe, expect, it } from "vitest";

import { assertStagedImportPayload } from "../contract";
import { buildViaBtcStagedPayload, historyToJournalStagedRows } from "./to-staged-payload";
import type { ViaBtcHistory } from "./types";

const HISTORY: ViaBtcHistory = {
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
    },
  ],
  rewards: [
    {
      coin: "DOGE",
      date: "2023-04-19",
      total_profit: "366.07702259",
    },
  ],
};

describe("historyToJournalStagedRows", () => {
  it("emits one inflow line per payment, profit, and reward", () => {
    const { staged } = historyToJournalStagedRows(HISTORY);
    expect(staged).toHaveLength(3);
    expect(staged[0]!["je_ref_#"]).toBe(HISTORY.payments[0]!.tx);
    expect(staged[0]!.debit).toBe("0.001");
    expect(staged[0]!.credit).toBe("");
    expect(staged[0]!.wallet_currency).toBe("BTC");
    expect(staged[1]!["je_ref_#"]).toBe("viabtc:profit:BTC:2018-10-05");
    expect(staged[1]!.debit).toBe("0.00002148");
    expect(staged[2]!.wallet_currency).toBe("DOGE");
    expect(staged[2]!.debit).toBe("366.07702259");
  });

  it("drops zero-amount earnings", () => {
    const { staged } = historyToJournalStagedRows({
      payments: [],
      profits: [{ coin: "BTC", date: "2018-10-05", total_profit: "0" }],
      rewards: [],
    });
    expect(staged).toHaveLength(0);
  });
});

describe("buildViaBtcStagedPayload", () => {
  it("emits a contract-valid payload named viabtc", () => {
    const { payload } = buildViaBtcStagedPayload(HISTORY);
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
    expect(payload.source.name).toBe("viabtc");
    expect(payload.summary.journalLines).toBe(3);
    expect(payload.summary.errors).toEqual([]);
  });

  it("an empty history is a valid payload with zero journal lines, not an error", () => {
    const { payload, warnings } = buildViaBtcStagedPayload({
      payments: [],
      profits: [],
      rewards: [],
    });
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
    expect(payload.staged.journalEntries).toBeUndefined();
    expect(payload.summary.journalLines).toBe(0);
    expect(warnings.some((w) => w.includes("no payout"))).toBe(true);
  });
});
