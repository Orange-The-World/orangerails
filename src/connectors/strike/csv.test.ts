import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildStrikeCsvStagedPayload, magnitude, normalizeStrikeDate, parseStrikeCsv } from "./csv";

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

  it("skips rows with unknown Direction and warns", () => {
    const text =
      "Date;Direction;Currency;Amount (Currency);Description;Destination\n" +
      "Sep 24 2024 13:21:51;Bogus;BTC;0.001;x;y";
    const res = parseStrikeCsv(text);
    expect(res.rows).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes("unknown Direction"))).toBe(true);
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
