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

  it("classifies a single() zero-row PGRST116 as empty when details confirm it", () => {
    // The real shape PostgREST returns: same PGRST116 code as the ambiguous
    // case above, but `details` says plainly that zero rows came back.
    expect(
      classifyRead(null, {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row",
      }),
    ).toBe("empty");
  });

  it("classifies a single() multi-row PGRST116 as error, never empty", () => {
    // Same code, but details confirm the OTHER case the code covers: more
    // than one row for a single(). This is a real data-integrity problem,
    // not an absent row, and guessing "empty" here would hide it.
    expect(
      classifyRead(null, {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "Results contain 2 rows, application/vnd.pgrst.object+json requires 1 row",
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
