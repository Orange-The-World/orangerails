import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCoinbaseCsvStagedPayload,
  coinbaseRowsToJournalStagedRows,
  coinbaseTypeDirection,
  magnitude,
  normalizeCoinbaseDate,
  parseCoinbaseCsv,
} from "./csv";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "sample.csv"), "utf8");

describe("parseCoinbaseCsv", () => {
  it("skips the metadata preamble and parses every data row", () => {
    const { rows, warnings } = parseCoinbaseCsv(FIXTURE);
    expect(rows).toHaveLength(6);
    expect(warnings).toEqual([]);
    expect(rows[0]).toMatchObject({ type: "Buy", asset: "BTC", quantity: "0.01000000" });
    expect(rows[0].notes).toBe("Bought 0.01 BTC");
  });

  it("resolves columns via header aliases regardless of order/casing", () => {
    const csv = ["type,timestamp,asset,amount", "Buy,2024-01-02T00:00:00Z,BTC,0.5"].join("\n");
    const { rows, warnings } = parseCoinbaseCsv(csv);
    expect(warnings).toEqual([]);
    expect(rows[0]).toMatchObject({
      type: "Buy",
      timestamp: "2024-01-02T00:00:00Z",
      asset: "BTC",
      quantity: "0.5",
    });
  });

  it("warns and returns no rows when the header row is absent", () => {
    const { rows, warnings } = parseCoinbaseCsv("just,some,preamble\nno,header,here");
    expect(rows).toEqual([]);
    expect(warnings.join(" ")).toMatch(/header row not found/i);
  });

  it("warns when a required column is missing", () => {
    const csv = ["Timestamp,Transaction Type,Notes", "2024-01-01T00:00:00Z,Buy,hi"].join("\n");
    const { warnings } = parseCoinbaseCsv(csv);
    expect(warnings.join(" ")).toMatch(/missing required column/i);
  });

  it("flags an empty file", () => {
    expect(parseCoinbaseCsv("").warnings.join(" ")).toMatch(/empty/i);
  });
});

describe("normalizeCoinbaseDate", () => {
  it("reduces an ISO-8601 UTC timestamp to YYYY-MM-DD", () => {
    expect(normalizeCoinbaseDate("2024-09-24T13:21:51Z")).toBe("2024-09-24");
  });
  it("leaves an unparseable value untouched", () => {
    expect(normalizeCoinbaseDate("Sep 24 2024")).toBe("Sep 24 2024");
  });
});

describe("coinbaseTypeDirection", () => {
  it("classifies inflows", () => {
    for (const t of ["Buy", "Receive", "Rewards Income", "Staking Income"]) {
      expect(coinbaseTypeDirection(t)).toBe("inflow");
    }
  });
  it("classifies outflows", () => {
    for (const t of ["Sell", "Send", "Convert", "Withdrawal"]) {
      expect(coinbaseTypeDirection(t)).toBe("outflow");
    }
  });
  it("returns null for an unknown type", () => {
    expect(coinbaseTypeDirection("Frobnicate")).toBeNull();
  });
});

describe("magnitude", () => {
  it("strips a leading minus sign", () => {
    expect(magnitude("-0.5")).toBe("0.5");
    expect(magnitude(" 1.25 ")).toBe("1.25");
  });
});

describe("coinbaseRowsToJournalStagedRows", () => {
  it("maps inflow to debit and outflow to credit, in the asset currency", () => {
    const { rows } = parseCoinbaseCsv(FIXTURE);
    const { staged, warnings } = coinbaseRowsToJournalStagedRows(rows);
    expect(staged).toHaveLength(6);

    const buy = staged[0];
    expect(buy).toMatchObject({
      je_date: "2024-09-24",
      wallet_currency: "BTC",
      debit: "0.01000000",
      credit: "",
    });

    const sell = staged[2];
    expect(sell).toMatchObject({ wallet_currency: "BTC", debit: "", credit: "0.00250000" });

    const convert = staged[3];
    expect(convert).toMatchObject({ wallet_currency: "ETH", debit: "", credit: "1.00000000" });

    // Unknown type is kept (never dropped), defaulted to debit, and warned.
    const unknown = staged[5];
    expect(unknown).toMatchObject({ debit: "0.00100000", credit: "" });
    // The warning must cite the TRUE file line (12 in the fixture), not the
    // row's position in the post-preamble array. Regression guard for the
    // off-by-preamble bug.
    expect(warnings.join(" ")).toMatch(/Row 12: unrecognized Coinbase type "Frobnicate"/);
  });
});

describe("buildCoinbaseCsvStagedPayload", () => {
  it("emits a contract-shaped payload with correct source + summary", () => {
    const { payload } = buildCoinbaseCsvStagedPayload({
      csvText: FIXTURE,
      fileName: "coinbase.csv",
    });
    expect(payload.contractVersion).toBe(1);
    expect(payload.source.name).toBe("coinbase");
    expect(payload.summary.journalLines).toBe(6);
    // No id column in this (common) export, so each transaction is its own
    // entry: 6 entries, NOT 1. Regression guard for the empty-ref collapse.
    expect(payload.summary.journalEntries).toBe(6);
    expect(payload.staged.journalEntries).toHaveLength(6);
    expect(payload.summary.accounts).toBe(0);
    expect(payload.summary.contacts).toBe(0);
  });

  it("counts shared non-empty ids as one entry, id-less rows as standalone", () => {
    const csv = [
      "Timestamp,Transaction Type,Asset,Quantity Transacted,ID",
      "2024-01-01T00:00:00Z,Buy,BTC,0.1,tx-aaa",
      "2024-01-01T00:00:00Z,Buy,BTC,0.2,tx-aaa",
      "2024-01-02T00:00:00Z,Sell,BTC,0.05,tx-bbb",
    ].join("\n");
    const { payload } = buildCoinbaseCsvStagedPayload({ csvText: csv });
    expect(payload.summary.journalLines).toBe(3);
    expect(payload.summary.journalEntries).toBe(2);
  });
});
