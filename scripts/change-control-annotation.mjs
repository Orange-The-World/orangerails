#!/usr/bin/env node
// The recorded production apply allowlist, and the reason recorded beside it,
// must not part company. OR-T1804, out of OR-T1794.
//
// ops/change-control/baseline.json records the reviewed value of
// MIGRATION_APPLY_ALLOWED_ACTORS_PROD. JSON carries no comments and the daily
// drift comparison reports any extra key as a difference, so the reason that
// value is what it is cannot live in that file. It lives in
// ops/change-control/README.md, which quotes the value verbatim beside the
// reasoning.
//
// The README states that a pull request changing the value must update the
// quoted block in the same pull request. That is a rule a person has to
// remember, which is the weakest kind of control in this directory. This is the
// part that does not depend on remembering.
//
// It reads two committed files. No network, no token, no secret, so it cannot be
// flaky, and there is no "I could not look" state for it to hide in.
//
// EXIT CODES, distinct on purpose. "I could not read the annotation" must never
// look like "they match":
//   0  the quoted block and the baseline agree
//   6  they differ. Both values are printed.
//   7  the annotation is missing, duplicated, or does not parse
//   8  the baseline is missing, does not parse, or does not carry the key
//
// This does NOT touch scripts/change-control-settings.mjs or what it compares.
// Different inputs, a different question, its own job.

import { readFileSync } from "node:fs";

const KEY = "MIGRATION_APPLY_ALLOWED_ACTORS_PROD";

// Overridable so the workflow can prove the alarm fires by pointing this at a
// mutated COPY. The committed files are never written by anything here.
const BASELINE = process.env.CHANGE_CONTROL_BASELINE || "ops/change-control/baseline.json";
const README = process.env.CHANGE_CONTROL_README || "ops/change-control/README.md";

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch (err) {
  die(8, `cannot read the baseline at ${BASELINE}: ${err.message}`);
}

const recorded = baseline && baseline.variables ? baseline.variables[KEY] : undefined;
if (!isNonEmptyStringArray(recorded)) {
  die(8, `${BASELINE} carries no non-empty ${KEY} array under "variables". There is nothing to compare the annotation against.`);
}

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch (err) {
  die(7, `cannot read ${README}: ${err.message}. The recorded value then has no reason beside it, which is the state this check exists to refuse.`);
}

const quotedBlocks = [...readme.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .filter((block) => block.includes(KEY));

if (quotedBlocks.length === 0) {
  die(7, `${README} quotes no json block containing ${KEY}. A missing annotation is not a pass: the value is recorded with no reason beside it.`);
}
if (quotedBlocks.length > 1) {
  die(7, `${README} quotes ${quotedBlocks.length} json blocks containing ${KEY}. Exactly one of them is the recorded value, and a reader cannot tell which.`);
}

let quoted;
try {
  quoted = JSON.parse(`{${quotedBlocks[0]}}`)[KEY];
} catch (err) {
  die(7, `the json block quoted in ${README} does not parse: ${err.message}`);
}
if (!isNonEmptyStringArray(quoted)) {
  die(7, `the json block quoted in ${README} carries no non-empty ${KEY} array.`);
}

// Order is not meaningful in an allowlist, so a reordering is not a difference.
// A changed, added or removed identity is.
const normalise = (value) => JSON.stringify([...value].sort());

if (normalise(quoted) !== normalise(recorded)) {
  die(
    6,
    [
      `${KEY} has parted company with the reason recorded beside it.`,
      `  ${BASELINE} records: ${JSON.stringify(recorded)}`,
      `  ${README} quotes:    ${JSON.stringify(quoted)}`,
      "A pull request that changes the recorded value must update the quoted block in the same pull request.",
    ].join("\n"),
  );
}

process.stdout.write(`${KEY} agrees with the block quoted in ${README}: ${JSON.stringify(recorded)}\n`);
