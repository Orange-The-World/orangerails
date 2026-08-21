import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildStrikeCsvStagedPayload,
  magnitude,
  normalizeStrikeDate,
  parseStrikeCsv,
  strikeRowsToJournalStagedRows,
} from "./csv";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "sample.csv"), "utf8");

describe("parseStrikeCsv", () => {
  it("auto-detects semicolon delimiter", () => {
    const res = parseStrikeCsv(FIXTURE);
    expect(res.delimiter).toBe(";");
    expect(res.warnings).toEqual([]);
  });

  it("parses all data rows", () => {
    const res = parseStrikeCsv(FIXTURE);
    expect(res.rows).toHaveLength(7);
  });

  it("normalizes Receive/Send direction labels", () => {
    const res = parseStrikeCsv(FIXTURE);
    expect(res.rows[0].direction).toBe("Receive");
    expect(res.rows[2].direction).toBe("Send");
  });

  it("preserves raw signed amount from Strike", () => {
    const res = parseStrikeCsv(FIXTURE);
    expect(res.rows[2].amount).toBe("-0.00009896");
  });

  it("captures LN invoice / BTC address in destination", () => {
    const res = parseStrikeCsv(FIXTURE);
    expect(res.rows[0].destination).toMatch(/^lnbc/);
    expect(res.rows[4].destination).toMatch(/^bc1q/);
  });

  it("also accepts comma-delimited input", () => {
    const text =
      "Date,Direction,Currency,Amount (Currency),Description,Destination,Fee,Reference\n" +
      "Oct 1 2024 10:00:00,Receive,BTC,0.00010000,Tip,lnbc100,0,x";
    const res = parseStrikeCsv(text);
    expect(res.delimiter).toBe(",");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].direction).toBe("Receive");
  });

  it("skips rows with an unknown Transaction Type and warns", () => {
    const text =
      "Date;Direction;Currency;Amount (Currency);Description;Destination\n" +
      "Sep 24 2024 13:21:51;Bogus;BTC;0.001;x;y";
    const res = parseStrikeCsv(text);
    expect(res.rows).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("unknown Transaction Type"))).toBe(true);
  });
});

/**
 * The shape of a genuine Strike "Annual transactions" export.
 *
 * Synthetic on purpose. The header row and the column semantics are copied
 * from a real export, every value below is invented: no real invoice, address,
 * hash or counterparty belongs in this repo.
 *
 * Note the two things that used to break us: the currency lives in the column
 * NAME (there is no Currency column at all), and the account currency is not
 * always USD.
 */
const REAL_SHAPE =
  "Reference,Date & Time (UTC),Transaction Type,Amount EUR,Fee EUR,Amount BTC,Fee BTC," +
  "BTC Price,Cost Basis (EUR),Destination,Description,Transaction Hash,Note\n" +
  "ref-recv,Nov 15 2024 14:48:37,Receive,,,0.00071111,,,,lnbc1example,\"\"\"Tip from someone\"\"\",hash-1,\n" +
  "ref-send,Mar 06 2026 8:50:27,Send,,,-0.00021022,0.00000022,,,lnbc2example,Invoice paid,hash-2,\n" +
  "ref-wdr,Mar 24 2026 13:51:00,Withdrawal,-345.84,,,,,,,,,\n" +
  "ref-buy,Aug 25 2025 12:26:05,Purchase,-99.02,1.26,0.00102333,,95531.26,99.02,,,,\n" +
  "ref-dup,Nov 21 2024 20:47:20,Sale,,,-0.00421625,0.00004958,120000,,,Initiated target order,,\n" +
  "ref-dup,Dec 15 2024 20:32:55,Sale,,,0.00421625,,120000,,,Cancelled target order,,";

describe("parseStrikeCsv against a genuine Strike export shape", () => {
  it("parses every row, where it previously parsed none", () => {
    const res = parseStrikeCsv(REAL_SHAPE);
    expect(res.delimiter).toBe(",");
    expect(res.rows).toHaveLength(6);
    expect(res.warnings).toEqual([]);
  });

  it("reads the currency off the header, because there is no Currency column", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    expect(rows[0].currency).toBe("BTC");
    expect(rows[2].currency).toBe("EUR");
    expect(rows[2].fiatCurrency).toBe("EUR");
  });

  it("keeps all five transaction types instead of only Receive and Send", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    expect(rows.map((r) => r.direction)).toEqual([
      "Receive",
      "Send",
      "Withdrawal",
      "Purchase",
      "Sale",
      "Sale",
    ]);
  });

  it("keeps both legs of a Purchase, and its price and cost basis", () => {
    const buy = parseStrikeCsv(REAL_SHAPE).rows[3];
    expect(buy.btcAmount).toBe("0.00102333");
    expect(buy.fiatAmount).toBe("-99.02");
    expect(buy.fiatFee).toBe("1.26");
    expect(buy.btcPrice).toBe("95531.26");
    expect(buy.costBasis).toBe("99.02");
  });

  it("keeps Description and Note apart", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    expect(rows[0].description).toBe('"Tip from someone"');
    expect(rows[0].note).toBeUndefined();
  });

  it("does not treat Reference as unique, because Strike reuses it", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    const dup = rows.filter((r) => r.reference === "ref-dup");
    expect(dup).toHaveLength(2);
    expect(dup[0].amount).toBe("-0.00421625");
    expect(dup[1].amount).toBe("0.00421625");
  });
});

describe("which side a row posts to", () => {
  // A file that states magnitudes only and puts the direction in the type
  // column. Nothing here carries a sign, so the type has to decide.
  const UNSIGNED = "Date,Direction,Currency,Amount (Currency),Description,Destination\n" +
    "Oct 1 2024 10:00:00,Receive,BTC,0.00010000,in,lnbc1\n" +
    "Oct 2 2024 10:00:00,Send,BTC,0.00020000,out,lnbc2";

  it("falls back to the type when no amount in the file is signed", () => {
    const { staged, warnings } = strikeRowsToJournalStagedRows(parseStrikeCsv(UNSIGNED).rows);
    expect(staged[0].debit).toBe("0.00010000");
    expect(staged[0].credit).toBe("");
    // The unsigned outflow is the case that matters: magnitude alone would
    // have posted it as a debit.
    expect(staged[1].credit).toBe("0.00020000");
    expect(staged[1].debit).toBe("");
    expect(warnings).toEqual([]);
  });

  it("lets the sign win in a signed file, and never guesses silently", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    const { staged, warnings } = strikeRowsToJournalStagedRows(rows);
    // The cancelled half of the target order is a positive, unsigned amount in
    // a file that signs its outflows. Its type says Sale, which alone would
    // post it as a credit and undo the cancellation.
    const cancelled = staged.find((r) => r.line_description === "Cancelled target order");
    expect(cancelled?.debit).toBe("0.00421625");
    expect(cancelled?.credit).toBe("");
    expect(warnings.some((w) => w.includes("opposite of what the type alone implies"))).toBe(true);
  });

  it("posts an unsigned inflow in a signed file without complaint", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    const { staged } = strikeRowsToJournalStagedRows(rows);
    const recv = staged.find((r) => r["je_ref_#"] === "ref-recv");
    expect(recv?.debit).toBe("0.00071111");
  });
});

describe("strikeRowsToJournalStagedRows on real-shape rows", () => {
  it("posts by the sign of the amount, not by the type label", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    const { staged } = strikeRowsToJournalStagedRows(rows);
    const wdr = staged.find((s) => s["je_ref_#"] === "ref-wdr");
    expect(wdr?.credit).toBe("345.84");
    expect(wdr?.debit).toBe("");
  });

  it("holds back two-legged rows rather than posting one side of them", () => {
    const rows = parseStrikeCsv(REAL_SHAPE).rows;
    const { staged, warnings } = strikeRowsToJournalStagedRows(rows);
    expect(staged.some((s) => s["je_ref_#"] === "ref-buy")).toBe(false);
    expect(warnings.some((w) => w.includes("two-sided staging"))).toBe(true);
  });
});

describe("normalizeStrikeDate", () => {
  it('handles "Sep 24 2024 13:21:51"', () => {
    expect(normalizeStrikeDate("Sep 24 2024 13:21:51")).toBe("2024-09-24");
  });
  it("handles single-digit day", () => {
    expect(normalizeStrikeDate("Sep 4 2024 13:21:51")).toBe("2024-09-04");
  });
  it("leaves unparseable strings as-is", () => {
    expect(normalizeStrikeDate("not a date")).toBe("not a date");
  });
});

describe("magnitude", () => {
  it("strips leading minus", () => {
    expect(magnitude("-0.00009896")).toBe("0.00009896");
  });
  it("leaves positive untouched", () => {
    expect(magnitude("0.00150000")).toBe("0.00150000");
  });
});

describe("buildStrikeCsvStagedPayload", () => {
  it("emits journalEntries with empty account columns", () => {
    const { payload } = buildStrikeCsvStagedPayload({ csvText: FIXTURE });
    expect(payload.source.name).toBe("strike");
    expect(payload.staged.journalEntries).toBeDefined();
    const rows = payload.staged.journalEntries!;
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.account_code).toBe("");
      expect(r.account_name).toBe("");
      expect(r.contact_name).toBe("");
    }
  });

  it("puts destination in memo, not contact_name", () => {
    const { payload } = buildStrikeCsvStagedPayload({ csvText: FIXTURE });
    const rows = payload.staged.journalEntries!;
    expect(rows[0].je_memo).toMatch(/^lnbc/);
    expect(rows[0].contact_name).toBe("");
  });

  it("routes Receive to debit and Send to credit (sign stripped)", () => {
    const { payload } = buildStrikeCsvStagedPayload({ csvText: FIXTURE });
    const rows = payload.staged.journalEntries!;
    expect(rows[0].debit).toBe("0.00150000");
    expect(rows[0].credit).toBe("");
    expect(rows[2].credit).toBe("0.00009896");
    expect(rows[2].debit).toBe("");
  });

  it("normalizes the je_date to YYYY-MM-DD", () => {
    const { payload } = buildStrikeCsvStagedPayload({ csvText: FIXTURE });
    const rows = payload.staged.journalEntries!;
    expect(rows[0].je_date).toBe("2024-09-24");
  });

  it("summary counts journal lines", () => {
    const { payload } = buildStrikeCsvStagedPayload({ csvText: FIXTURE });
    expect(payload.summary.journalLines).toBe(7);
  });
});
