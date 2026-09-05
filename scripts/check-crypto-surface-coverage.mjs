#!/usr/bin/env node
/**
 * check-crypto-surface-coverage.mjs
 *
 * Fails loud when a file that transitively imports one of our crypto
 * primitive modules is not covered by any active HIGH ship_rules pattern.
 *
 * WHY THIS EXISTS (OR-T2210). ship_rules classifies risk by matching a
 * regex against a file's PATH. That only catches a file whose name already
 * signals what it does. A new file added under src/lib, or a route file,
 * that imports vault.ts or key-derivation.ts is invisible to the gate on
 * the day it is created, and stays invisible until someone reads it.
 *
 * WHAT THIS DOES NOT DO. It does not classify anything itself and it does
 * not merge or block a PR directly: it fails a CI check, loudly, naming
 * every offending file, so a human decides whether the fix is a new
 * ship_rules pattern or a refactor that narrows the surface (moving the
 * crypto calls out of a large file into one already covered, for example).
 * It does not replace ship_rules and it does not widen any of its terms:
 * it is a coverage net UNDER it, catching exactly the case a path-substring
 * match cannot see by construction.
 *
 * ALGORITHM
 *  1. Walk src/**\/*.ts(x), extract every static, side-effect and dynamic
 *     import specifier with a regex (this repo is ESM-only, package.json
 *     "type": "module"; require() is matched too, defensively).
 *  2. Resolve each specifier that is relative (./, ../) or aliased (@/,
 *     which tsconfig.json maps to ./src/*) against real files on disk,
 *     trying the specifier as-is, then + .ts/.tsx/.js/.jsx, then
 *     + /index.ts/.tsx. A bare specifier (node_modules) is not our
 *     surface and is skipped.
 *  3. Build the reverse import graph (file -> who imports it) and BFS
 *     from CRYPTO_PRIMITIVES (below) over that reverse graph. Every file
 *     reached, plus the primitives themselves, is the crypto surface.
 *  4. Load the active high-risk patterns from .github/ship-rules.json
 *     (the same file merge-sweep.yml reads) and test each surface file's
 *     path against every one, case-insensitively: the same test
 *     merge-sweep.yml runs (grep -qEi).
 *  5. Any surface file matched by zero high patterns is a violation.
 *     Print every one and exit 1. Otherwise print the surface size and
 *     exit 0.
 *
 * KNOWN LIMITS, stated rather than hidden. A computed or templated dynamic
 * import (import(someVariable)) is not resolved: this reads specifiers as
 * literal strings only. CRYPTO_PRIMITIVES is a seed list decided by a
 * person (OR-T2160), not inferred; it is not this script's job to guess
 * which files are primitives, only to find what depends on the named ones.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const RULES_PATH = join(REPO_ROOT, '.github', 'ship-rules.json');

// Seed set: the files that ARE this product's zero-knowledge crypto layer,
// per OR-T2160. Two names from that ticket, "co-admin-keyring" and
// "vault-persist", did not resolve to a file under those names when this
// script was written (searched the tree, zero matches); rather than guess
// a path they are left out. If they exist under a different name, add
// them here, and re-run this script to confirm it still passes.
const CRYPTO_PRIMITIVES = [
  'src/lib/vault.ts',
  'src/lib/key-derivation.ts',
  'src/lib/key-wrapping.ts',
  'src/lib/co-admin.ts',
  'src/lib/pqc.ts',
  'src/lib/pqc-lifecycle.ts',
  'src/context/VaultContext.tsx',
];

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_IMPORT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function extractSpecifiers(text) {
  const specs = new Set();
  for (const re of [FROM_RE, DYNAMIC_RE, BARE_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) specs.add(m[1]);
  }
  return specs;
}

function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec);
  } else if (spec.startsWith('@/')) {
    base = join(SRC_ROOT, spec.slice(2));
  } else {
    return null; // bare specifier (node_modules or similar): not our surface
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function main() {
  if (!existsSync(SRC_ROOT)) {
    console.error(`::error::crypto-surface-coverage: ${SRC_ROOT} does not exist.`);
    process.exit(1);
  }
  if (!existsSync(RULES_PATH)) {
    console.error(`::error::crypto-surface-coverage: ${RULES_PATH} is missing. It is generated from the ship_rules table. Refusing to check coverage against no rules.`);
    process.exit(1);
  }

  const files = walk(SRC_ROOT);
  const forward = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const deps = new Set();
    for (const spec of extractSpecifiers(text)) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved) deps.add(resolved);
    }
    forward.set(file, deps);
  }

  const reverse = new Map();
  for (const [file, deps] of forward) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(file);
    }
  }

  const primitiveAbs = CRYPTO_PRIMITIVES.map((p) => join(REPO_ROOT, p)).filter((p) => {
    if (!existsSync(p)) {
      console.error(`::warning::crypto-surface-coverage: seed file not found on disk, skipping: ${relative(REPO_ROOT, p)}`);
      return false;
    }
    return true;
  });

  const surface = new Set(primitiveAbs);
  const queue = [...primitiveAbs];
  while (queue.length) {
    const cur = queue.pop();
    const importers = reverse.get(cur);
    if (!importers) continue;
    for (const imp of importers) {
      if (!surface.has(imp)) {
        surface.add(imp);
        queue.push(imp);
      }
    }
  }

  const rulesDoc = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
  const highPatterns = (rulesDoc.rules ?? [])
    .filter((r) => r.risk === 'high')
    .map((r) => new RegExp(r.pattern, 'i'));

  if (highPatterns.length === 0) {
    console.error('::error::crypto-surface-coverage: .github/ship-rules.json has zero active high-risk rules. Refusing to check coverage against no rules.');
    process.exit(1);
  }

  const violations = [];
  for (const abs of surface) {
    const rel = relative(REPO_ROOT, abs);
    if (!highPatterns.some((re) => re.test(rel))) violations.push(rel);
  }
  violations.sort();

  if (violations.length > 0) {
    console.error(`::error::crypto-surface-coverage: ${violations.length} file(s) reachable from the crypto primitives are NOT matched by any active high-risk ship_rules pattern.`);
    for (const v of violations) {
      console.error(`::error file=${v}::${v} is reachable from a crypto primitive (see CRYPTO_PRIMITIVES) but no active high-risk ship_rules pattern matches its path.`);
    }
    console.error('::error::Fix: either widen/add a ship_rules high pattern to cover it (a database change, see OR-T2086 for who holds write), or narrow the surface by moving the crypto calls out of this file into one already covered. This check does not decide which; a human does.');
    process.exit(1);
  }

  console.log(`crypto-surface-coverage: OK. ${surface.size} file(s) on the crypto import surface (seeded from ${primitiveAbs.length} primitive(s)), all matched by an active high-risk ship_rules pattern.`);
}

main();
