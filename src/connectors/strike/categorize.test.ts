import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseStrikeCsv } from "./csv";
import { suggestCategorization } from "./categorize";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "sample.csv"), "utf8");

describe("suggestCategorization", () => {
  it("groups all Receive rows under Bitcoin Income", () => {
    const { rows } = parseStrikeCsv(FIXTURE);
    const sugg = suggestCategorization(rows);
    const receive = sugg.find((s) => s.id === "receive-all");
    expect(receive).toBeDefined();
    expect(receive!.suggestedAccountName).toBe("Bitcoin Income");
    expect(receive!.count).toBe(2);
  });

  it("groups sub-1k-sat Send rows under Network Fees", () => {
    const { rows } = parseStrikeCsv(FIXTURE);
    const sugg = suggestCategorization(rows);
    const small = sugg.find((s) => s.id === "send-small");
    expect(small).toBeDefined();
    expect(small!.suggestedAccountName).toBe("Network Fees");
    expect(small!.count).toBeGreaterThan(0);
  });

  it("groups large Send rows under Bitcoin Expense", () => {
    const { rows } = parseStrikeCsv(FIXTURE);
    const sugg = suggestCategorization(rows);
    const large = sugg.find((s) => s.id === "send-large");
    expect(large).toBeDefined();
    expect(large!.suggestedAccountName).toBe("Bitcoin Expense");
    expect(large!.count).toBeGreaterThan(0);
  });

  it("preserves row references via rowIndices", () => {
    const { rows } = parseStrikeCsv(FIXTURE);
    const sugg = suggestCategorization(rows);
    for (const group of sugg) {
      for (const idx of group.rowIndices) {
        expect(rows[idx]).toBeDefined();
      }
    }
  });

  it("returns empty list for empty input", () => {
    expect(suggestCategorization([])).toEqual([]);
  });

  it("includes up to 3 sample rows per group for UI preview", () => {
    const { rows } = parseStrikeCsv(FIXTURE);
    const sugg = suggestCategorization(rows);
    for (const group of sugg) {
      expect(group.sampleRows.length).toBeLessThanOrEqual(3);
      expect(group.sampleRows.length).toBeLessThanOrEqual(group.count);
    }
  });
});
