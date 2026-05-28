import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock `playwright` so the runner can be exercised in unit tests without a
// real browser. We control:
//   - The body bytes returned by `context.request.get` (Shift_JIS-safe ASCII
//     is fine; the existing BojSource parser uses TextDecoder('shift_jis')
//     which round-trips ASCII bit-for-bit).
//   - The HTTP status code.

interface MockResponse {
  status: number;
  body: string; // ASCII-only is fine — round-trips through shift_jis.
}

let mockResponses: MockResponse[] = [];
let responseIdx = 0;

vi.mock("playwright", () => {
  return {
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => undefined,
            waitForTimeout: async () => undefined,
          }),
          request: {
            get: async () => {
              const r = mockResponses[responseIdx++] ?? { status: 200, body: "" };
              const bytes = new TextEncoder().encode(r.body);
              return {
                status: () => r.status,
                body: async () => Buffer.from(bytes),
              };
            },
          },
        }),
        close: async () => undefined,
      }),
    },
  };
});

import { runBojPlaywright } from "../../scripts/central-banks/boj-playwright-runner";

const HAPPY_CSV = `"Series code","FM08'FXERATE@5USD"
"Title","Foreign Exchange Rates / 5pm Tokyo / U.S. dollar"
"Unit","Yen per US$"
"Frequency","Daily"
"Date","FM08'FXERATE@5USD"
"2024/03/01","150.32"
"2024/03/04","150.21"
`;

const NO_DATA_CSV = `"Series code","FM08'FXERATE@5USD"
"Title","Foreign Exchange Rates / 5pm Tokyo / U.S. dollar"
"Unit","Yen per US$"
"Frequency","Daily"
"Date","FM08'FXERATE@5USD"
"2024/03/01","ND"
"2024/03/02","ND"
`;

describe("boj-playwright-runner", () => {
  beforeEach(() => {
    mockResponses = [];
    responseIdx = 0;
  });

  it("happy path: parses CSV body into BojParsedRow[]", async () => {
    mockResponses = [{ status: 200, body: HAPPY_CSV }];
    const result = await runBojPlaywright({
      pairs: ["USD/JPY"],
      yearFrom: 2024,
      yearTo: 2024,
      log: () => undefined,
    });
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]!.pair).toBe("USD/JPY");
    expect(result.rows[0]!.date).toBe("2024-03-01");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.status).toBe(200);
    expect(result.diagnostics[0]!.parsedRows).toBe(2);
    expect(result.diagnostics[0]!.firstDate).toBe("2024-03-01");
  });

  it("no-data day: returns empty rows + a clean diagnostic (no crash)", async () => {
    mockResponses = [{ status: 200, body: NO_DATA_CSV }];
    const logs: string[] = [];
    const result = await runBojPlaywright({
      pairs: ["USD/JPY"],
      yearFrom: 2024,
      yearTo: 2024,
      log: (m) => logs.push(m),
    });
    expect(result.rows).toEqual([]);
    expect(result.diagnostics[0]!.status).toBe(200);
    expect(result.diagnostics[0]!.parsedRows).toBe(0);
    expect(result.diagnostics[0]!.firstDate).toBeNull();
  });

  it("non-200: logs warning + records diagnostic, does not crash", async () => {
    mockResponses = [{ status: 503, body: "<html>service unavailable</html>" }];
    const logs: string[] = [];
    const result = await runBojPlaywright({
      pairs: ["USD/JPY"],
      yearFrom: 2024,
      yearTo: 2024,
      log: (m) => logs.push(m),
    });
    expect(result.rows).toEqual([]);
    expect(result.diagnostics[0]!.status).toBe(503);
    expect(logs.join("\n")).toMatch(/WARN/);
  });
});
