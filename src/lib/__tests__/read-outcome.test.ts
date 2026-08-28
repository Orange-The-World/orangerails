import { describe, it, expect } from "vitest";
import { classifyRead } from "../read-outcome";

describe("classifyRead", () => {
  it("is a row when data is present and there is no error", () => {
    expect(classifyRead({ id: 1 }, null)).toBe("row");
  });

  it("is empty when data is null and there is no error", () => {
    expect(classifyRead(null, null)).toBe("empty");
  });

  it("is empty when data is an empty array and there is no error", () => {
    expect(classifyRead([], null)).toBe("empty");
  });

  it("is empty when a .single() zero-row error (PGRST116) is present, not an error", () => {
    expect(classifyRead(null, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" })).toBe(
      "empty",
    );
  });

  it("is an error for any other error code", () => {
    expect(classifyRead(null, { code: "PGRST301", message: "JWT expired" })).toBe("error");
  });

  it("is an error for an error with no code at all", () => {
    expect(classifyRead(null, { message: "network error" })).toBe("error");
  });

  it("is an error even when data happens to be present alongside an error", () => {
    expect(classifyRead({ id: 1 }, { code: "PGRST301", message: "JWT expired" })).toBe("error");
  });
});
