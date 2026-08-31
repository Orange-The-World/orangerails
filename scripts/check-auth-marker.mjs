#!/usr/bin/env node
/**
 * CI gate: a function that supabase/functions/public-auth.json declares as
 * authenticating its caller must contain a call to the one shared, named
 * auth helper (requireCallerAuth, in
 * supabase/functions/_shared/require-caller-auth.ts). A function declared
 * "none" must not.
 *
 * WHY A MARKER, NOT AN ANALYSIS OF THE CODE. This is deliberate design, not
 * a shortcut. check-public-auth.mjs's own header documents why detecting
 * real authentication by scanning code was tried on this repo first and
 * rejected: it produced six false positives, because the real check lived
 * in a shared helper the pattern did not know about. A heuristic that
 * misses reads as coverage, which is worse than no check, because a control
 * that appears to work is what stops anyone from looking. So nothing here
 * decides whether a function's auth is CORRECT. It decides only whether a
 * function that claims to authenticate its caller shows the one call we
 * actually review, and whether a function that claims no caller auth is
 * honest about that.
 *
 * THE GAP THIS CLOSES (OR-T1041). check-public-auth.mjs asserts the
 * manifest and config.toml agree with EACH OTHER, in both directions.
 * Neither that check nor anything else ever asked whether the mode a
 * function DECLARES is the mode its code IMPLEMENTS. or-institutions-
 * catalog shipped declaring "platform-api-key" while authenticating nobody
 * (OR-T1039), and the manifest/config check stayed green throughout,
 * because both sides of that check agreed with each other and neither
 * looked at the function's actual code.
 *
 * KNOWN EXCEPTIONS. requireCallerAuth is new: nothing calls it yet. Making
 * this gate fail red across every declared function on day one would get it
 * switched off within a week, which is worse than not having it. So every
 * function that already declares caller auth and has not yet been migrated
 * onto the shared helper is listed below, by name, dated to when this gate
 * landed. An entry here says "not wired up yet", never "this one is fine".
 * Migrating each is tracked in OR-T1039 (or-institutions-catalog) and
 * OR-T1040 (every other name on this list) -- not a new ticket per function,
 * because those two already cover the full sweep this list enumerates.
 * Remove a name the day its function starts calling requireCallerAuth. Do
 * not add a new name without a reason and a tracking ticket in the same
 * commit.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS_DIR = "supabase/functions";
const MANIFEST = join(FUNCTIONS_DIR, "public-auth.json");
const HELPER_CALL = /requireCallerAuth\s*\(/;

// Dated 2026-08-31, the day this gate landed (OR-T1041).
const KNOWN_EXCEPTIONS = new Set([
  "or-connection-cancel",
  "or-connection-confirm",
  "or-connection-create",
  "or-connection-delete",
  "or-connection-list",
  "or-discover-wallets",
  "or-institutions-catalog",
  "or-link-complete",
  "or-link-mint-token",
  "or-platform-bootstrap",
  "or-provision",
  "or-quiltt-accounts",
  "or-quiltt-disconnect",
  "or-quiltt-drain-alert",
  "or-quiltt-link-complete",
  "or-quiltt-session",
  "or-quiltt-session-revoke",
  "or-quiltt-session-via-widget",
  "or-quiltt-sync",
  "or-quiltt-webhook",
  "or-source-wallet-lookup",
  "or-source-wallets-set",
  "or-stealth-connection-create",
  "or-stealth-connection-delete",
  "or-stealth-connection-list",
  "or-stealth-envelope-fetch",
  "or-stealth-envelope-update",
  "or-stealth-transactions-list",
  "or-stealth-transactions-store",
  "or-strike-webhook",
  "or-sync",
  "or-sync-key-register",
  "or-transactions-list",
  "or-webhook-dispatch",
  "v1-rate",
]);

const note = (m) => console.log(m);

if (!existsSync(MANIFEST)) {
  // check-public-auth.mjs already owns "the manifest is missing entirely";
  // there is nothing for this gate to check without it.
  note(`skip: no ${MANIFEST} in this repo`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")).functions ?? {};

function allTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const fail = [];
let matched = 0;
let exceptioned = 0;

for (const [fn, mode] of Object.entries(manifest)) {
  const dir = join(FUNCTIONS_DIR, fn);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    // check-public-auth.mjs already flags a manifest entry with no function
    // directory; nothing more to say about it here.
    continue;
  }

  const source = allTsFiles(dir).map((f) => readFileSync(f, "utf8")).join("\n");
  const callsHelper = HELPER_CALL.test(source);

  if (mode === "none") {
    if (callsHelper) {
      fail.push(
        `${fn}: declares "none" (no caller auth) in public-auth.json but calls requireCallerAuth. ` +
        `Either the declaration is wrong, or this function does authenticate its caller and the ` +
        `manifest must say which mode.`);
    } else {
      matched++;
    }
    continue;
  }

  if (callsHelper) {
    matched++;
    continue;
  }

  if (KNOWN_EXCEPTIONS.has(fn)) {
    exceptioned++;
    continue;
  }

  fail.push(
    `${fn}: declares "${mode}" caller auth in public-auth.json but contains no call to ` +
    `requireCallerAuth (supabase/functions/_shared/require-caller-auth.ts). Wire this function's ` +
    `auth through requireCallerAuth, or if this is a genuine pre-existing gap being migrated ` +
    `separately, add it to KNOWN_EXCEPTIONS in this script with a dated reason and a tracking ticket.`);
}

if (fail.length) {
  console.error("auth-marker check FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}

note(
  `auth-marker OK: ${matched} function(s) match their declared mode, ` +
  `${exceptioned} known exception(s) pending migration (OR-T1039, OR-T1040).`);
