import { describe, it, expect } from "vitest";

import {
  parseTypesFile,
  liveFromRows,
  buildFindings,
  applyBaseline,
  assertReadable,
} from "./check-types-drift.mjs";

/**
 * A minimal Supabase generated type file, in the exact indent ladder the real
 * one uses. widgets is deliberately correct against BASE_ROWS below, so every
 * red in this file comes from a difference the test introduces on purpose.
 */
const TYPES = [
  "export type Database = {",
  "  public: {",
  "    Tables: {",
  "      widgets: {",
  "        Row: {",
  "          created_at: string",
  "          id: string",
  "          label: string | null",
  "          owner_id: string",
  "        }",
  "        Insert: {",
  "          created_at?: string",
  "          id?: string",
  "          label?: string | null",
  "          owner_id: string",
  "        }",
  "        Update: {",
  "          created_at?: string",
  "          id?: string",
  "          label?: string | null",
  "          owner_id?: string",
  "        }",
  "        Relationships: []",
  "      }",
  "    }",
  "    Views: {",
  "      [_ in never]: never",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

const BASE_ROWS = [
  { relation: "widgets", relkind: "r", column_name: "created_at", is_nullable: false, has_default: true },
  { relation: "widgets", relkind: "r", column_name: "id", is_nullable: false, has_default: true },
  { relation: "widgets", relkind: "r", column_name: "label", is_nullable: true, has_default: false },
  { relation: "widgets", relkind: "r", column_name: "owner_id", is_nullable: false, has_default: false },
];

const kinds = (findings) => findings.map((f) => f.kind).sort();

function findingsFor(rows, source = TYPES) {
  return buildFindings(liveFromRows(rows), parseTypesFile(source));
}

describe("parseTypesFile", () => {
  it("reads the tables, the fields and the optional marker", () => {
    const tables = parseTypesFile(TYPES);
    expect([...tables.keys()]).toEqual(["widgets"]);
    const widgets = tables.get("widgets");
    expect([...widgets.sections.Row.keys()]).toEqual([
      "created_at",
      "id",
      "label",
      "owner_id",
    ]);
    expect(widgets.sections.Insert.get("owner_id").optional).toBe(false);
    expect(widgets.sections.Insert.get("created_at").optional).toBe(true);
    expect(widgets.sections.Row.get("label").type).toBe("string | null");
  });

  it("returns nothing for a file it cannot read, which the caller treats as UNKNOWN", () => {
    expect(parseTypesFile("export type Database = {}\n").size).toBe(0);
  });
});

describe("a type file that matches the applied schema", () => {
  it("produces no findings at all", () => {
    expect(findingsFor(BASE_ROWS)).toEqual([]);
  });
});

describe("forced differences, each one must go red", () => {
  it("a column the database has and the type file does not", () => {
    // This is the real 2026-08 failure: wrapped_data_keys.grant_sig, NOT NULL,
    // live since 20260804000001 and absent from the type file for weeks.
    const rows = [
      ...BASE_ROWS,
      { relation: "widgets", relkind: "r", column_name: "grant_sig", is_nullable: false, has_default: false },
    ];
    const found = findingsFor(rows);
    expect(kinds(found)).toEqual(["missing-column", "missing-insert-column"]);
    expect(found[0].detail).toContain("widgets.grant_sig");
  });

  it("a nullability that disagrees", () => {
    const rows = BASE_ROWS.map((r) =>
      r.column_name === "label" ? { ...r, is_nullable: false } : r,
    );
    const found = findingsFor(rows);
    expect(kinds(found)).toEqual(["insert-too-strict", "nullability"]);
    expect(found.find((f) => f.kind === "nullability").detail).toContain("NOT NULL");
  });

  it("an Insert that lets a required column be omitted", () => {
    // id NOT NULL with no default, typed optional: the insert typechecks and
    // the database refuses it. Exactly the guard this file exists to keep.
    const rows = BASE_ROWS.map((r) =>
      r.column_name === "id" ? { ...r, has_default: false } : r,
    );
    const found = findingsFor(rows);
    expect(kinds(found)).toEqual(["insert-too-loose"]);
  });

  it("a whole table that exists live and is not declared", () => {
    const rows = [
      ...BASE_ROWS,
      { relation: "data_keys", relkind: "r", column_name: "id", is_nullable: false, has_default: true },
    ];
    const found = findingsFor(rows);
    expect(kinds(found)).toEqual(["missing-table"]);
    expect(found[0].relation).toBe("data_keys");
  });

  it("a view that exists live and is not declared", () => {
    const rows = [
      ...BASE_ROWS,
      { relation: "v_platform_quiltt_config", relkind: "v", column_name: "id", is_nullable: true, has_default: false },
    ];
    expect(kinds(findingsFor(rows))).toEqual(["missing-view"]);
  });

  it("a column the type file declares and the database does not have", () => {
    const rows = BASE_ROWS.filter((r) => r.column_name !== "label");
    expect(kinds(findingsFor(rows))).toEqual(["extra-column"]);
  });

  it("accepts a string encoded boolean from the Management API", () => {
    // The API has returned "t"/"f" as well as true/false. Reading "t" as
    // falsey would invert every nullability verdict and report drift as clean.
    const rows = BASE_ROWS.map((r) => ({
      ...r,
      is_nullable: r.is_nullable ? "t" : "f",
      has_default: r.has_default ? "t" : "f",
    }));
    expect(findingsFor(rows)).toEqual([]);
  });
});

describe("the baseline waiver list", () => {
  const drifted = [
    ...BASE_ROWS,
    { relation: "platforms", relkind: "r", column_name: "id", is_nullable: false, has_default: true },
  ];

  it("suppresses a named, reviewed difference and nothing else", () => {
    const { blocking, suppressed } = applyBaseline(findingsFor(drifted), {
      waived: { platforms: { reason: "known backlog", ticket: "DEV-0393" } },
    });
    expect(blocking).toEqual([]);
    expect(kinds(suppressed)).toEqual(["missing-table"]);
  });

  it("still blocks a difference that is not on the list", () => {
    const alsoBroken = [
      ...drifted,
      { relation: "audit_entries", relkind: "r", column_name: "id", is_nullable: false, has_default: true },
    ];
    const { blocking } = applyBaseline(findingsFor(alsoBroken), {
      waived: { platforms: { reason: "known backlog", ticket: "DEV-0393" } },
    });
    expect(blocking.map((f) => f.relation)).toEqual(["audit_entries"]);
  });

  it("goes red when a waiver no longer covers anything, so the list cannot rot", () => {
    const { blocking } = applyBaseline(findingsFor(BASE_ROWS), {
      waived: { platforms: { reason: "known backlog", ticket: "DEV-0393" } },
    });
    expect(kinds(blocking)).toEqual(["stale-baseline"]);
  });
});

describe("it must never report I could not check as a pass", () => {
  it("an empty schema read is UNKNOWN, not clean", () => {
    const reason = assertReadable(new Map(), parseTypesFile(TYPES));
    expect(reason).toContain("NOT read");
  });

  it("an unparseable type file is UNKNOWN, not clean", () => {
    const reason = assertReadable(liveFromRows(BASE_ROWS), new Map());
    expect(reason).toContain("NOT read");
  });

  it("both sides readable returns no reason", () => {
    expect(assertReadable(liveFromRows(BASE_ROWS), parseTypesFile(TYPES))).toBeNull();
  });
});
