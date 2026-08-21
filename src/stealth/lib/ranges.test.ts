/**
 * Tests for the scan-coverage resume rule.
 *
 * The case that matters most is "a range exists but does not reach back to
 * the birthday". The cursor this replaces answered that case with the highest
 * number it had ever seen, which silently declared an unscanned window
 * scanned. Every other case here is a boundary or a malformed-input guard.
 */

import { describe, expect, it } from "vitest";

import { resumeHeightFromRanges, type ScanRange } from "./ranges";

const BIRTHDAY = 800_000;

describe("resumeHeightFromRanges", () => {
  it("returns the birthday when there is no coverage at all", () => {
    expect(resumeHeightFromRanges(undefined, BIRTHDAY)).toBe(BIRTHDAY);
    expect(resumeHeightFromRanges(null, BIRTHDAY)).toBe(BIRTHDAY);
    expect(resumeHeightFromRanges([], BIRTHDAY)).toBe(BIRTHDAY);
  });

  it("resumes at to_height when a range contains the birthday", () => {
    const ranges: ScanRange[] = [{ from_height: 799_000, to_height: 850_000 }];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(850_000);
  });

  it("returns the birthday when a range sits entirely AHEAD of it", () => {
    // This is the regression the old single cursor could not express. The
    // wallet was scanned from 900000 up, the birthday is 800000, and blocks
    // 800000 to 899999 have never been read. Resuming at 950000 would leave
    // that window permanently invisible.
    const ranges: ScanRange[] = [{ from_height: 900_000, to_height: 950_000 }];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(BIRTHDAY);
  });

  it("returns the birthday when a range sits entirely BEHIND it", () => {
    const ranges: ScanRange[] = [{ from_height: 700_000, to_height: 750_000 }];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(BIRTHDAY);
  });

  it("ignores non-containing ranges even when they are higher", () => {
    const ranges: ScanRange[] = [
      { from_height: 799_000, to_height: 810_000 }, // contains the birthday
      { from_height: 900_000, to_height: 999_999 }, // higher, but disjoint
    ];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(810_000);
  });

  it("takes the furthest reach when several ranges contain the birthday", () => {
    // record_stealth_scan_range() merges on insert so overlapping rows should
    // not exist, but the read must not depend on the writer being perfect.
    const ranges: ScanRange[] = [
      { from_height: 799_000, to_height: 805_000 },
      { from_height: 780_000, to_height: 830_000 },
    ];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(830_000);
  });

  it("treats both interval ends as inclusive", () => {
    expect(resumeHeightFromRanges([{ from_height: BIRTHDAY, to_height: 820_000 }], BIRTHDAY)).toBe(
      820_000,
    );
    expect(resumeHeightFromRanges([{ from_height: 790_000, to_height: BIRTHDAY }], BIRTHDAY)).toBe(
      BIRTHDAY,
    );
  });

  it("ignores an inverted range rather than trusting it", () => {
    const ranges: ScanRange[] = [{ from_height: 850_000, to_height: 799_000 }];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(BIRTHDAY);
  });

  it("ignores non-finite bounds rather than propagating them", () => {
    const ranges = [
      { from_height: 0, to_height: Number.POSITIVE_INFINITY },
      { from_height: Number.NaN, to_height: 900_000 },
    ] as ScanRange[];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBe(BIRTHDAY);
  });

  it("never returns a height below the birthday", () => {
    const ranges: ScanRange[] = [{ from_height: 0, to_height: BIRTHDAY - 1 }];
    expect(resumeHeightFromRanges(ranges, BIRTHDAY)).toBeGreaterThanOrEqual(BIRTHDAY);
  });

  it("accepts a birthday of zero", () => {
    expect(resumeHeightFromRanges([{ from_height: 0, to_height: 10 }], 0)).toBe(10);
  });

  it("rejects a non-finite birthday instead of scanning from NaN", () => {
    expect(() => resumeHeightFromRanges([], Number.NaN)).toThrow(/finite/);
  });
});
