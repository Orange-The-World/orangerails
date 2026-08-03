#!/usr/bin/env node
/**
 * Refuses the build while any legal placeholder is unfilled.
 *
 * Runs ahead of vite in the `build` script, so this is a hard gate on
 * every path that can reach a browser: CI and the Cloudflare Pages build
 * both run `bun run build`.
 *
 * What it checks: the five values in LEGAL_VALUES in src/content/legal.ts
 * are set to something real. Bracket tags in the prose below that literal
 * are correct and are substituted at render time, so they are not checked
 * and must not be.
 *
 * To make this pass: fill the five values. Do not delete the check, and do
 * not put a plausible-looking guess in a legal document.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGAL_FILE = path.join(ROOT, "src", "content", "legal.ts");

const REQUIRED_KEYS = [
  "companyLegalName",
  "jurisdiction",
  "contactEmail",
  "effectiveDate",
  "retentionDays",
];

/** A value that still looks like [SOMETHING] has not been filled. */
const UNFILLED = /\[[^\]]*\]/;

function fail(lines) {
  console.error("");
  console.error("Legal placeholder check FAILED.");
  for (const line of lines) console.error("  " + line);
  console.error("");
  console.error("Fill the values in src/content/legal.ts. Owner: legal and governance.");
  console.error("");
  process.exit(1);
}

const source = await readFile(LEGAL_FILE, "utf8").catch(() => null);
if (source === null) {
  fail([`Cannot read ${path.relative(ROOT, LEGAL_FILE)}.`,
        "The legal copy moved or was deleted. Point this check at the new file."]);
}

const block = source.match(/export const LEGAL_VALUES: LegalValues = \{([\s\S]*?)\n\};/);
if (!block) {
  fail(["Could not find the LEGAL_VALUES literal in src/content/legal.ts.",
        "It was refactored into a shape this check cannot read. Update the check,",
        "do not remove it: an unreadable check is the same as no check."]);
}

const found = new Map();
for (const line of block[1].split("\n")) {
  const m = line.match(/^\s*(\w+):\s*"([^"]*)"\s*,?\s*$/);
  if (m) found.set(m[1], m[2]);
}

const problems = [];
for (const key of REQUIRED_KEYS) {
  if (!found.has(key)) {
    problems.push(`${key}: missing from LEGAL_VALUES.`);
    continue;
  }
  const value = found.get(key).trim();
  if (value === "") {
    problems.push(`${key}: empty.`);
  } else if (UNFILLED.test(value)) {
    problems.push(`${key}: still a placeholder (${found.get(key)}).`);
  }
}

if (problems.length > 0) fail(problems);

console.log(`Legal placeholder check passed: ${REQUIRED_KEYS.length} values set.`);
