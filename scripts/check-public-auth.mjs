#!/usr/bin/env node
/**
 * CI gate: every publicly-exposed edge function must be declared, and every declared one must
 * actually be public. Bidirectional, so neither direction can drift silently.
 *
 * THE BUG THIS PREVENTS shipped twice: an HMAC-authenticated webhook receiver missing
 * `verify_jwt = false` in config.toml, so the gateway rejects the sender before our own auth ever
 * runs and deliveries silently never arrive.
 *
 * WHY DECLARATION AND NOT DETECTION, which is the whole design and was arrived at empirically.
 *
 * The obvious approach is to have CI find receivers by scanning code for signature checks. That
 * was tried on this repo first. It produced SIX FALSE POSITIVES, because the real authentication
 * lives in a shared helper the pattern did not know about.
 *
 * A heuristic that misses reads as coverage, and that is worse than having no check at all,
 * because a control that appears to work stops anyone from looking. The same failure showed up
 * twice more in this codebase on the same day: an `.order()` that looked like it guaranteed
 * determinism and did nothing because every timestamp tied, and an analytics gate that would have
 * passed its own test while still collecting.
 *
 * So functions declare themselves in a manifest, and CI checks the manifest against config.
 *
 * WHAT THIS DOES NOT DO, and it matters that nobody assumes otherwise: it verifies INTENT, not
 * implementation. A function listed as `hmac` that validates its signature wrongly still passes.
 * Mechanism catches the drift; a human catches the logic.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS_DIR = "supabase/functions";
const CONFIG = "supabase/config.toml";
const MANIFEST = join(FUNCTIONS_DIR, "public-auth.json");

const fail = [];
const note = (m) => console.log(m);

if (!existsSync(CONFIG)) {
  note(`skip: no ${CONFIG} in this repo`);
  process.exit(0);
}
if (!existsSync(MANIFEST)) {
  console.error(
    `MISSING: ${MANIFEST}\n` +
    `Every function deliberately exposed to the public internet must be listed there, with its\n` +
    `auth mode. Create it as {"functions": {"<name>": "hmac" | "platform-api-key" | "none"}}.`);
  process.exit(1);
}

// Minimal TOML read: we only need [functions.<name>] blocks and their verify_jwt value.
const configText = readFileSync(CONFIG, "utf8");
const declaredFalse = new Set();
let current = null;
for (const line of configText.split("\n")) {
  const s = line.trim();
  if (s.startsWith("#")) continue;
  const header = s.match(/^\[functions\.([^\]]+)\]$/);
  if (header) { current = header[1]; continue; }
  if (current && /^verify_jwt\s*=\s*false\b/.test(s)) { declaredFalse.add(current); current = null; }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")).functions ?? {};
const listed = new Set(Object.keys(manifest));

// Direction 1: listed as public but the gateway still guards it. This is the original bug: the
// sender is rejected before our own auth runs, and deliveries silently never arrive.
for (const fn of listed) {
  if (!declaredFalse.has(fn)) {
    fail.push(
      `${fn}: listed in public-auth.json as "${manifest[fn]}" but config.toml does not set ` +
      `verify_jwt = false. The gateway will reject callers before this function's own auth runs.`);
  }
}

// Direction 2: gateway check disabled without declaring why. This is the more dangerous
// direction: an unauthenticated endpoint shipping by accident.
for (const fn of declaredFalse) {
  if (!listed.has(fn)) {
    fail.push(
      `${fn}: config.toml sets verify_jwt = false but it is not in public-auth.json. Turning off ` +
      `the gateway check without declaring the function's own auth is how an unauthenticated ` +
      `endpoint ships. Add it with its real auth mode, or remove verify_jwt = false.`);
  }
}

// Direction 3: a manifest entry for a function that no longer exists, so the list stays honest.
if (existsSync(FUNCTIONS_DIR)) {
  const onDisk = new Set(
    readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name));
  for (const fn of listed) {
    if (!onDisk.has(fn)) fail.push(`${fn}: in public-auth.json but no such function directory.`);
  }
}

if (fail.length) {
  console.error("public-auth check FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
note(`public-auth OK: ${listed.size} declared public function(s), config and manifest agree.`);
