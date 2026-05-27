import { describe, expect, it, vi, beforeEach } from "vitest";

// We mock the `playwright` module so the runner exercises its
// orchestration logic + the parser hand-off without needing a real
// browser binary in CI.

interface MockExtraction {
  headers: string[];
  rows: string[][];
  tableCount: number;
  firstHeaderSample: string;
}

let mockExtraction: MockExtraction = {
  headers: [],
  rows: [],
  tableCount: 0,
  firstHeaderSample: "",
};

vi.mock("playwright", () => {
  return {
    chromium: {
      launch: async () => {
        // Each call to `page.evaluate` returns the next queued result.
        // The runner makes two evaluate calls: (1) scroll, (2) extract.
        let evalCalls = 0;
        const page = {
          goto: async () => undefined,
          waitForTimeout: async () => undefined,
          evaluate: async (_fn: unknown) => {
            evalCalls++;
            if (evalCalls === 1) return undefined; // scroll evaluate
            return mockExtraction; // extraction evaluate
          },
        };
        return {
          newContext: async () => ({ newPage: async () => page }),
          close: async () => undefined,
        };
      },
    },
  };
});

import { runSnbPlaywright, extractSnbTable } from "../../scripts/central-banks/snb-playwright-runner";

describe("snb-playwright-runner", () => {
  beforeEach(() => {
    mockExtraction = { headers: [], rows: [], tableCount: 0, firstHeaderSample: "" };
  });

  it("happy path: extracts rows + hands to parseTable", async () => {
    mockExtraction = {
      headers: ["Datum", "USD1", "EUR1", "JPY100"],
      rows: [
        ["01.03.2024", "0.8852", "0.9587", "0.5901"],
        ["04.03.2024", "0.8810", "0.9550", "0.5895"],
      ],
      tableCount: 2,
      firstHeaderSample: "Datum",
    };

    const rows = await runSnbPlaywright({ log: () => undefined });
    // 3 pairs * 2 dates = 6 SnbParsedRow entries.
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const usdMar1 = rows.find((r) => r.pair === "USD/CHF" && r.date === "2024-03-01");
    expect(usdMar1).toBeDefined();
    expect(usdMar1!.foreignPerChf).toBeCloseTo(0.8852, 6);
  });

  it("no-data day: returns empty array + logs a diagnostic warning", async () => {
    mockExtraction = {
      headers: [],
      rows: [],
      tableCount: 0,
      firstHeaderSample: "",
    };
    const logs: string[] = [];
    const rows = await runSnbPlaywright({ log: (m) => logs.push(m) });
    expect(rows).toEqual([]);
    expect(logs.join("\n")).toMatch(/no usable table/i);
  });

  it("extractSnbTable surfaces table count + first-header diagnostics", async () => {
    mockExtraction = {
      headers: ["Date", "USD1"],
      rows: [["2024-05-01", "0.91"]],
      tableCount: 3,
      firstHeaderSample: "Date",
    };
    const out = await extractSnbTable({ log: () => undefined });
    expect(out.tableCount).toBe(3);
    expect(out.firstHeaderSample).toBe("Date");
    expect(out.headers).toEqual(["Date", "USD1"]);
  });
});
