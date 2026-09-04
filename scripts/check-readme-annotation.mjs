#!/usr/bin/env node
/**
 * OR-T1804, out of OR-T1794.
 *
 * ops/change-control/README.md quotes the value of
 * MIGRATION_APPLY_ALLOWED_ACTORS_PROD, recorded in ops/change-control/baseline.json,
 * next to the reason that identity is on the production allowlist. Nothing stopped
 * the two from being edited independently: the value could change in baseline.json
 * (a reviewed, intended change) while the quoted block in the README kept saying
 * the old value, so the recorded reason would silently stop describing the recorded
 * setting.
 *
 * This compares the two committed files. It calls no API and needs no token: it is
 * a diff between two files already in the checkout, so it can run on any pull
 * request that touches either one.
 *
 * Exit codes, distinguished on purpose: "could not check" must never read the same
 * as "checked, and it matches".
 *   0  both files parsed and the value matches
 *   1  both files parsed and the value differs (both values are named)
 *   2  ops/change-control/baseline.json has no variables.MIGRATION_APPLY_ALLOWED_ACTORS_PROD array
 *   3  ops/change-control/README.md has no fenced json block quoting the key, or
 *      that block does not parse as JSON, or the file cannot be read
 */
import { readFileSync } from "node:fs";

const KEY = "MIGRATION_APPLY_ALLOWED_ACTORS_PROD";
const baselinePath = process.env.CHANGE_CONTROL_BASELINE_PATH || "ops/change-control/baseline.json";
const readmePath = process.env.CHANGE_CONTROL_README_PATH || "ops/change-control/README.md";

function readBaselineValue(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`${path} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  const value = json && json.variables ? json.variables[KEY] : undefined;
  if (!Array.isArray(value)) {
    console.error(`${path} has no variables.${KEY} array.`);
    process.exit(2);
  }
  return value;
}

function readReadmeValue(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`cannot read ${path}: ${err.message}`);
    process.exit(3);
  }
  const fenceRe = /```json\n([\s\S]*?)\n```/g;
  let match;
  let block = null;
  while ((match = fenceRe.exec(raw)) !== null) {
    if (match[1].includes(`"${KEY}"`)) {
      block = match[1];
      break;
    }
  }
  if (block === null) {
    console.error(
      `${path} has no fenced json block quoting ${KEY}. A missing quote is not a ` +
        "match, it is the loudest failure this check can report.",
    );
    process.exit(3);
  }
  let parsed;
  try {
    parsed = JSON.parse(`{${block}}`);
  } catch (err) {
    console.error(`${path}'s quoted block does not parse as JSON: ${err.message}`);
    process.exit(3);
  }
  const value = parsed[KEY];
  if (!Array.isArray(value)) {
    console.error(`${path}'s quoted block has no ${KEY} array.`);
    process.exit(3);
  }
  return value;
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function main() {
  const baselineValue = readBaselineValue(baselinePath);
  const readmeValue = readReadmeValue(readmePath);
  if (!sameArray(baselineValue, readmeValue)) {
    console.error(
      `${KEY} parted company: ${baselinePath} has ${JSON.stringify(baselineValue)}, ` +
        `${readmePath} quotes ${JSON.stringify(readmeValue)}. Update the quoted block ` +
        "in the same pull request that changes the baseline.",
    );
    process.exit(1);
  }
  console.log(`${KEY} matches in both files: ${JSON.stringify(baselineValue)}.`);
}

main();
