import { describe, expect, it } from "vitest";

import {
  SLUG,
  nextFreeVersion,
  versionFor,
} from "./new-migration.mjs";

describe("versionFor", () => {
  it("is 14 digits, left-padded, for single digit fields", () => {
    // 2026-01-02 03:04:05 UTC. Every field is one digit, so anything that is not
    // padded shows up here rather than silently producing a shorter version.
    const v = versionFor(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    expect(v).toBe("20260102030405");
    expect(v).toHaveLength(14);
  });

  it("reads the clock in UTC, not local time", () => {
    // A timestamp that is a different calendar day in most western zones.
    expect(versionFor(new Date("2026-01-01T00:30:00Z"))).toBe("20260101003000");
  });

  it("keeps a real seconds value instead of rounding to the hour", () => {
    expect(versionFor(new Date("2026-08-31T12:00:37Z"))).toBe("20260831120037");
  });

  it("sorts lexically in the same order as time, across a rollover", () => {
    const moments = [
      new Date("2026-08-31T23:59:59Z"),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-01T00:00:01Z"),
      new Date("2026-10-01T00:00:00Z"),
    ];
    const versions = moments.map(versionFor);
    expect([...versions].sort()).toEqual(versions);
  });
});

describe("nextFreeVersion", () => {
  it("returns the clock's own second when nothing is taken", () => {
    const { version, moved } = nextFreeVersion(
      new Date("2026-08-31T12:00:37Z"),
      new Set(),
    );
    expect(version).toBe("20260831120037");
    expect(moved).toBe(0);
  });

  it("walks forward past a taken second", () => {
    const { version, moved } = nextFreeVersion(
      new Date("2026-08-31T12:00:37Z"),
      new Set(["20260831120037"]),
    );
    expect(version).toBe("20260831120038");
    expect(moved).toBe(1);
  });

  it("walks past a chain of taken seconds, which is what was being done by hand", () => {
    const taken = new Set([
      "20260831120037",
      "20260831120038",
      "20260831120039",
    ]);
    const { version, moved } = nextFreeVersion(
      new Date("2026-08-31T12:00:37Z"),
      taken,
    );
    expect(version).toBe("20260831120040");
    expect(moved).toBe(3);
  });

  it("fails loudly rather than spinning when an hour is exhausted", () => {
    // A check that cannot fail is not known to work, so prove this one can.
    const start = new Date("2026-08-31T12:00:00Z");
    const taken = new Set();
    for (let i = 0; i <= 3601; i += 1) {
      const at = new Date(start.getTime() + i * 1000);
      taken.add(versionFor(at));
    }
    expect(() => nextFreeVersion(start, taken)).toThrow(/not a real state/);
  });
});

describe("the two constraints the deploy path depends on", () => {
  it("puts the version before the first underscore, even when the slug has underscores", () => {
    const { version } = nextFreeVersion(
      new Date("2026-08-31T12:00:37Z"),
      new Set(),
    );
    const filename = `${version}_add_widget_table_v2.sql`;
    // This is the rule the deploy check applies with `ls | cut -d_ -f1`.
    expect(filename.split("_")[0]).toBe(version);
  });

  it("produces a fixed width version, so ordering guards keep working", () => {
    const widths = new Set(
      [
        "2026-01-01T00:00:00Z",
        "2026-08-31T12:00:37Z",
        "2026-12-31T23:59:59Z",
      ].map((iso) => versionFor(new Date(iso)).length),
    );
    expect([...widths]).toEqual([14]);
  });
});

describe("SLUG", () => {
  it("accepts a lowercase underscore separated slug", () => {
    expect(SLUG.test("add_widget_table")).toBe(true);
    expect(SLUG.test("backfill_platforms_sink_format")).toBe(true);
  });

  it("rejects shapes that would confuse the version parse or the file listing", () => {
    for (const bad of ["Add_Widget", "2_add_widget", "add-widget", "", "_add"]) {
      expect(SLUG.test(bad)).toBe(false);
    }
  });
});
