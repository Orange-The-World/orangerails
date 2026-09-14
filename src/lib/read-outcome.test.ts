import { describe, it, expect } from "vitest";
import { classifyRead } from "./read-outcome";

describe("classifyRead", () => {
  it("classifies a present row as row", () => {
    expect(classifyRead({ id: "1" }, null)).toBe("row");
  });

  it("classifies a non-empty array as row", () => {
    expect(classifyRead([{ id: "1" }], null)).toBe("row");
  });

  it("classifies null data with no error as empty (maybeSingle, no match)", () => {
    expect(classifyRead(null, null)).toBe("empty");
  });

  it("classifies an empty array with no error as empty", () => {
    expect(classifyRead([], null)).toBe("empty");
  });

  it("classifies null data with an error as error, never empty (single(), zero rows)", () => {
    expect(
      classifyRead(null, {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
      }),
    ).toBe("error");
  });

  it("classifies a real query failure as error, never empty", () => {
    // e.g. a renamed or missing column, rejected by PostgREST for the whole query.
    expect(
      classifyRead(null, { code: "42703", message: 'column "foo" does not exist' }),
    ).toBe("error");
  });

  it("classifies an error alongside a non-empty array as error, not row", () => {
    // maybeSingle() error path with a stale data value should still read as error.
    expect(classifyRead([{ id: "1" }], { code: "PGRST301", message: "JWT expired" })).toBe(
      "error",
    );
  });
});
