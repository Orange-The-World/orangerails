import { describe, expect, it } from "vitest";
import { classifyRead } from "../read-outcome";

describe("classifyRead", () => {
  it("classifies a row as row", () => {
    expect(classifyRead({ id: "1" }, null)).toBe("row");
  });

  it("classifies null data with no error as empty", () => {
    expect(classifyRead(null, null)).toBe("empty");
  });

  it("classifies an empty array as empty", () => {
    expect(classifyRead([], null)).toBe("empty");
  });

  it("classifies a .single() zero-row PGRST116 error as empty, not error", () => {
    expect(
      classifyRead(null, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }),
    ).toBe("empty");
  });

  it("classifies any other error code as error", () => {
    expect(classifyRead(null, { code: "42501", message: "permission denied" })).toBe("error");
  });

  it("classifies an error object with no code as error", () => {
    expect(classifyRead(null, { message: "network error" })).toBe("error");
  });
});
