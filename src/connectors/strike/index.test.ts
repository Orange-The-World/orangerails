import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ingestStrike, StrikeApiUnavailableError } from "./index";

const FIXTURE_PATH = join(__dirname, "__fixtures__", "sample.csv");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

describe("ingestStrike", () => {
  it("csv source: parses fixture and emits categorization suggestions", async () => {
    const res = await ingestStrike({ source: "csv", csvText: FIXTURE });
    expect(res.pathUsed).toBe("csv");
    expect(res.payload.source.name).toBe("strike");
    expect(res.payload.summary.journalLines).toBe(7);
    expect(res.categorizationSuggestions.length).toBeGreaterThan(0);
  });

  it("csv source: also works from a Buffer", async () => {
    const res = await ingestStrike({ source: "csv", csvBuffer: Buffer.from(FIXTURE, "utf8") });
    expect(res.pathUsed).toBe("csv");
    expect(res.payload.summary.journalLines).toBe(7);
  });

  it("csv source: also works from a file path", async () => {
    const res = await ingestStrike({ source: "csv", csvPath: FIXTURE_PATH });
    expect(res.pathUsed).toBe("csv");
    expect(res.payload.summary.journalLines).toBe(7);
  });

  it("auto mode falls back to CSV when API health check fails", async () => {
    const res = await ingestStrike({
      source: "auto",
      apiKey: "fake-key",
      csvText: FIXTURE,
      fetchImpl: failingFetch(),
    });
    expect(res.pathUsed).toBe("csv");
    expect(res.warnings.some((w) => w.includes("Strike API unavailable"))).toBe(true);
    expect(res.payload.summary.journalLines).toBe(7);
  });

  it("auto mode with no apiKey uses CSV directly", async () => {
    const res = await ingestStrike({ source: "auto", csvText: FIXTURE });
    expect(res.pathUsed).toBe("csv");
  });

  it("auto mode throws StrikeApiUnavailableError when API fails and no CSV is provided", async () => {
    await expect(
      ingestStrike({ source: "auto", apiKey: "fake-key", fetchImpl: failingFetch() }),
    ).rejects.toBeInstanceOf(StrikeApiUnavailableError);
  });

  it("api source: surfaces StrikeApiUnavailableError when key missing", async () => {
    await expect(ingestStrike({ source: "api" })).rejects.toBeInstanceOf(StrikeApiUnavailableError);
  });
});
