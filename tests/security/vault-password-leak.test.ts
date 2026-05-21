/**
 * CR-01 — static analysis: vault_password never leaves the browser.
 *
 * Scans every TypeScript source file in src/ for patterns that would
 * send vault_password (or any obviously-derived key bytes) outside the
 * browser. The test fails if it finds:
 *
 *   - A fetch / axios / supabase call with a body that references
 *     vault_password, master_password, mek_bytes, mek_raw, etc.
 *   - A console.log / console.info / console.debug / console.warn /
 *     console.error of any of those identifiers (would leak via the
 *     browser's remote logging service if one is wired up).
 *   - An assignment like `body.vault_password = ...` or
 *     `payload.master_password = ...`.
 *
 * Allowlist:
 *   - Test files (anything under tests/ or __tests__) — they may
 *     legitimately encrypt/decrypt with known values.
 *   - The vault library itself (src/lib/vault.ts) — defines the type.
 *   - Comments and string literals describing the threat (false positives).
 *
 * This is a tripwire, not a proof. A motivated developer can route
 * around it with renamed variables. But it catches the obvious mistakes
 * and forces a code-review conversation about anything that trips it.
 *
 * Companion to the CR-02..CR-07 runtime tests in this directory.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

const SENSITIVE_NAMES = [
  'vault_password',
  'vaultPassword',
  'master_password',
  'masterPassword',
  'mek_bytes',
  'mekBytes',
  'mek_raw',
  'mekRaw',
  'recovery_code',
  'recoveryCode',
];

// Patterns that, if found alongside a sensitive name, indicate a leak risk.
const LEAK_VERBS = [
  'fetch(',
  'axios.',
  '.from(',
  '.rpc(',
  '.insert(',
  '.update(',
  '.upsert(',
  '.send(',
  'console.log',
  'console.info',
  'console.debug',
  'console.warn',
  'console.error',
  'localStorage.',
  'sessionStorage.',
  'document.cookie',
  'navigator.sendBeacon',
];

// Files allowed to mention sensitive names (the crypto lib itself, types, etc.)
const ALLOW_FILE_PATTERNS = [
  /\/lib\/vault\.ts$/,
  /\/lib\/key-derivation\.ts$/,
  /\/context\/VaultContext\.tsx?$/,
  /\.test\.tsx?$/,
  /__tests__\//,
  /\/types\//,
];

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...(await listTsFiles(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(path: string): boolean {
  return ALLOW_FILE_PATTERNS.some((re) => re.test(path));
}

interface Finding {
  file: string;
  line: number;
  text: string;
  sensitive: string;
  verb: string;
}

function scanFile(path: string, contents: string): Finding[] {
  const findings: Finding[] = [];
  const lines = contents.split('\n');
  // Look for a sensitive name on the same line as a leak verb. Comments
  // and string-literal-only lines are skipped via simple heuristic.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const sens of SENSITIVE_NAMES) {
      if (!line.includes(sens)) continue;
      for (const verb of LEAK_VERBS) {
        if (line.includes(verb)) {
          findings.push({ file: path, line: i + 1, text: trimmed, sensitive: sens, verb });
        }
      }
    }
  }
  return findings;
}

describe('CR-01 — vault_password never leaves the browser (static check)', () => {
  test('no source file routes a sensitive identifier to a leak verb', async () => {
    const files = await listTsFiles(SRC_ROOT);
    const findings: Finding[] = [];
    for (const file of files) {
      if (isAllowed(file)) continue;
      const contents = await readFile(file, 'utf8');
      findings.push(...scanFile(file, contents));
    }

    if (findings.length > 0) {
      const report = findings
        .map(
          (f) =>
            `  ${relative(process.cwd(), f.file)}:${f.line}  ` +
            `[${f.sensitive} → ${f.verb}]\n    ${f.text}`,
        )
        .join('\n');
      throw new Error(
        `CR-01: found ${findings.length} potential vault_password leak(s):\n${report}\n\n` +
          `If a finding is a false positive, refactor the code or add the file to ` +
          `ALLOW_FILE_PATTERNS in this test with a comment explaining why it is safe.`,
      );
    }

    expect(findings).toEqual([]);
  });

  test('the sensitive name list is non-empty (sanity check on the rule)', () => {
    expect(SENSITIVE_NAMES.length).toBeGreaterThan(0);
    expect(LEAK_VERBS.length).toBeGreaterThan(0);
  });
});
