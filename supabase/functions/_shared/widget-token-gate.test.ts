import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyRequireWidgetToken,
  describeRequireWidgetTokenGap,
} from "./widget-token-gate.ts";

// ── one test per state ──────────────────────────────────────────────

Deno.test('classifyRequireWidgetToken: "true" -> state "true"', () => {
  assertEquals(classifyRequireWidgetToken("true"), "true");
});

Deno.test('classifyRequireWidgetToken: "false" -> state "false"', () => {
  assertEquals(classifyRequireWidgetToken("false"), "false");
});

Deno.test('classifyRequireWidgetToken: unset (undefined) -> "unset-or-unrecognised"', () => {
  assertEquals(classifyRequireWidgetToken(undefined), "unset-or-unrecognised");
});

// ── case-insensitivity is preserved (matches the original .toLowerCase()) ──

Deno.test('classifyRequireWidgetToken: "TRUE" -> "true" (case-insensitive)', () => {
  assertEquals(classifyRequireWidgetToken("TRUE"), "true");
});

Deno.test('classifyRequireWidgetToken: "False" -> "false" (case-insensitive)', () => {
  assertEquals(classifyRequireWidgetToken("False"), "false");
});

// ── the footgun values named in DEV-0204: must NOT be coerced to "true",
// and must land in the reported bucket, not disappear ──────────────────

Deno.test('classifyRequireWidgetToken: "1" is unrecognised, not permissive-by-accident-true', () => {
  assertEquals(classifyRequireWidgetToken("1"), "unset-or-unrecognised");
});

Deno.test('classifyRequireWidgetToken: "yes" is unrecognised', () => {
  assertEquals(classifyRequireWidgetToken("yes"), "unset-or-unrecognised");
});

Deno.test('classifyRequireWidgetToken: "True " (trailing space) is unrecognised, not "true"', () => {
  assertEquals(classifyRequireWidgetToken("True "), "unset-or-unrecognised");
});

Deno.test('classifyRequireWidgetToken: empty string is unset-or-unrecognised', () => {
  assertEquals(classifyRequireWidgetToken(""), "unset-or-unrecognised");
});

// ── describeRequireWidgetTokenGap distinguishes "never set" from
// "set to something we do not honour", which is the actual ask: an
// unrecognised value must be reported as unrecognised, not silently
// folded into "unset" with no trace of what was actually typed ──────

Deno.test("describeRequireWidgetTokenGap: unset names itself as not set", () => {
  const msg = describeRequireWidgetTokenGap(undefined);
  assertMatch(msg, /not set/i);
});

Deno.test("describeRequireWidgetTokenGap: unrecognised value is named verbatim", () => {
  const msg = describeRequireWidgetTokenGap("1");
  assertMatch(msg, /unrecognised/i);
  assertMatch(msg, /"1"/);
});

Deno.test('describeRequireWidgetTokenGap: "True " unrecognised value is named verbatim, space and all', () => {
  const msg = describeRequireWidgetTokenGap("True ");
  assertMatch(msg, /unrecognised/i);
  assertMatch(msg, /"True "/);
});

// ── behaviour-preservation: PR 1 must not change what requireToken
// evaluates to for ANY input. Cross-check against the exact original
// expression from or-link-complete/index.ts line 246-247. ───────────

Deno.test("classifyRequireWidgetToken matches the original inline expression for every case", () => {
  const originalRequireToken = (raw: string | undefined): boolean =>
    (raw ?? "false").toLowerCase() === "true";

  const cases: Array<string | undefined> = [
    undefined,
    "",
    "true",
    "TRUE",
    "True",
    "false",
    "FALSE",
    "False",
    "1",
    "0",
    "yes",
    "no",
    "True ",
    " true",
  ];

  for (const raw of cases) {
    const newIsTrue = classifyRequireWidgetToken(raw) === "true";
    const oldIsTrue = originalRequireToken(raw);
    assertEquals(
      newIsTrue,
      oldIsTrue,
      `mismatch for raw=${JSON.stringify(raw)}: new=${newIsTrue} old=${oldIsTrue}`,
    );
  }
});
