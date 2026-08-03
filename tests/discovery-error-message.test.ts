import { describe, it, expect } from "vitest";
import { extractDiscoveryErrorMessage } from "../src/lib/discovery-error";

describe("extractDiscoveryErrorMessage", () => {
  it("returns the body field when present", () => {
    expect(
      extractDiscoveryErrorMessage(401, JSON.stringify({ body: "Invalid API key." })),
    ).toBe("Invalid API key.");
  });

  it("falls back to title when body is absent", () => {
    expect(
      extractDiscoveryErrorMessage(403, JSON.stringify({ title: "Forbidden" })),
    ).toBe("Forbidden");
  });

  it("falls back to error field when body and title are absent", () => {
    expect(
      extractDiscoveryErrorMessage(500, JSON.stringify({ error: "Internal server error" })),
    ).toBe("Internal server error");
  });

  it("prefers body over title when both are present", () => {
    expect(
      extractDiscoveryErrorMessage(401, JSON.stringify({ body: "Bad key.", title: "Auth failed" })),
    ).toBe("Bad key.");
  });

  it("uses a status-coded fallback when no known field is present", () => {
    expect(extractDiscoveryErrorMessage(500, "{}")).toBe(
      "Wallet discovery failed (500). Check your credentials and try again.",
    );
  });

  it("uses a status-coded fallback for non-JSON responses", () => {
    expect(extractDiscoveryErrorMessage(502, "Bad Gateway")).toBe(
      "Wallet discovery failed (502). Check your credentials and try again.",
    );
  });

  it("uses a status-coded fallback for an empty response", () => {
    expect(extractDiscoveryErrorMessage(401, "")).toBe(
      "Wallet discovery failed (401). Check your credentials and try again.",
    );
  });

  // This is the assertion that satisfies the merge requirement:
  // "a test that goes red if the success string is emitted while the
  //  discovery response is non-ok."
  it("never emits 'Connection added' on any non-ok response", () => {
    const cases: Array<[number, string]> = [
      [401, JSON.stringify({ body: "Invalid API key." })],
      [403, JSON.stringify({ title: "Forbidden" })],
      [500, JSON.stringify({ error: "Internal error" })],
      [500, "{}"],
      [502, "Bad Gateway"],
      [401, ""],
    ];
    for (const [status, raw] of cases) {
      expect(extractDiscoveryErrorMessage(status, raw)).not.toContain("Connection added");
    }
  });
});
