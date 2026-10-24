/**
 * CR-01 , static analysis: vault_password never leaves the browser.
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
 *   - Test files (anything under tests/ or __tests__) , they may
 *     legitimately encrypt/decrypt with known values.
 *   - The vault library itself (src/lib/vault.ts) , defines the type.
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
import { POST_MESSAGE_VERBS, type PostMessageVerb } from '@/lib/postmessage-contract';

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
  'postMessage',
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

/**
 * Multi-line postMessage context scanner.
 *
 * For each non-comment line that contains `postMessage(`, collects:
 *   - Up to 14 non-comment lines of context before it
 *   - The call text from that line to the matching closing ')', up to 40 lines
 *
 * Strips string literals from the collected block, then flags if any
 * SENSITIVE_NAMES member or any identifier matching /password/i appears in
 * what remains. This catches build-by-assignment patterns like:
 *   const payload = {};
 *   payload.vaultPassword = pw;   // sensitive identifier, different line
 *   window.opener?.postMessage(payload, origin);
 * where a same-line rule cannot fire.
 */
function scanFileMultiLine(path: string, contents: string): Finding[] {
  const findings: Finding[] = [];
  const lines = contents.split('\n');

  function isCommentLine(l: string): boolean {
    const t = l.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  }

  function stripStringLiterals(text: string): string {
    let s = text.replace(/`(?:[^`\\]|\\.)*`/g, '``');
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    const pmIdx = line.indexOf('postMessage(');
    if (pmIdx === -1) continue;

    // Collect up to 14 non-comment context lines before this line (in order)
    const contextBefore: string[] = [];
    for (let j = i - 1; j >= 0 && contextBefore.length < 14; j--) {
      if (!isCommentLine(lines[j])) contextBefore.unshift(lines[j]);
    }

    // Walk from postMessage( to the matching closing ')' (cap 40 lines)
    const callLines: string[] = [line];
    let depth = 0;
    let done = false;
    for (const ch of line.slice(pmIdx)) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { done = true; break; }
      }
    }
    if (!done) {
      for (let k = i + 1; k < lines.length && k - i < 40; k++) {
        callLines.push(lines[k]);
        for (const ch of lines[k]) {
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) { done = true; break; }
          }
        }
        if (done) break;
      }
    }

    const block = [...contextBefore, ...callLines].join('\n');
    const stripped = stripStringLiterals(block);

    let flagged = false;
    for (const sens of SENSITIVE_NAMES) {
      if (stripped.includes(sens)) {
        findings.push({ file: path, line: i + 1, text: line.trim(), sensitive: sens, verb: 'postMessage' });
        flagged = true;
        break;
      }
    }
    if (!flagged && /password/i.test(stripped)) {
      const m = stripped.match(/\b\w*password\w*\b/i);
      const ident = m ? m[0] : 'password';
      findings.push({ file: path, line: i + 1, text: line.trim(), sensitive: ident, verb: 'postMessage' });
    }
  }

  return findings;
}

describe('CR-01 , vault_password never leaves the browser (static check)', () => {
  test('no source file routes a sensitive identifier to a leak verb', async () => {
    const files = await listTsFiles(SRC_ROOT);
    const findings: Finding[] = [];
    for (const file of files) {
      if (isAllowed(file)) continue;
      const contents = await readFile(file, 'utf8');
      findings.push(...scanFile(file, contents));
      findings.push(...scanFileMultiLine(file, contents));
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

  // ---------------------------------------------------------------------------
  // Per-verb synthetic leak lines.
  //
  // Typed as Record<PostMessageVerb, string>: adding a new verb to
  // POST_MESSAGE_VERBS without a corresponding entry here causes a TypeScript
  // compile error, forcing the author to write an explicit test case before CI
  // passes. Test count = allowlist length (enforced by the loop below).
  // ---------------------------------------------------------------------------
  const VERB_TEST_LINES: Record<PostMessageVerb, string> = {
    'or-cred-key-ready':
      "window.opener.postMessage({ type: 'or-cred-key-ready', vaultPassword: password }, origin);",
  };

  test(
    'CR-01 fires on vaultPassword + postMessage for every allowed verb' +
      ' (test count equals allowlist length)',
    () => {
      // This loop is the canonical red-path proof for the verb allowlist:
      // OR-T2704 removed vault_password from the outgoing postMessage payload;
      // OR-T2722 adds a structural guard so the check stays current even as
      // the verb list grows. Adding a verb to POST_MESSAGE_VERBS without
      // adding a VERB_TEST_LINES entry is a TypeScript error; adding an entry
      // whose synthetic line does NOT trip CR-01 is caught here at runtime.
      expect(POST_MESSAGE_VERBS.length).toBeGreaterThan(0);
      for (const verb of POST_MESSAGE_VERBS) {
        const syntheticPath = '/fake/src/routes/connect.tsx';
        const syntheticContent = [
          '// normal line',
          VERB_TEST_LINES[verb],
          '// another normal line',
        ].join('\n');
        const findings = scanFile(syntheticPath, syntheticContent);
        expect(
          findings.length,
          `CR-01 did not fire for verb "${verb}" -- ` +
            `VERB_TEST_LINES['${verb}'] must include a sensitive name on the same line as postMessage`,
        ).toBeGreaterThan(0);
        expect(
          findings.some((f) => f.verb === 'postMessage'),
          `finding for verb "${verb}" should name postMessage as the leak verb`,
        ).toBe(true);
        expect(
          findings.some((f) => f.sensitive === 'vaultPassword'),
          `finding for verb "${verb}" should name vaultPassword as the sensitive identifier`,
        ).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Multi-line context scanner fixtures (CR-01 postMessage window rule).
  //
  // Each red fixture must produce at least 1 finding; each clean fixture must
  // produce 0. This proves the rule can both fire and stay silent in one CI
  // run (neither author nor reviewer has shell access for manual verification).
  // Fixtures are verbatim lines from the repo per OR-T2722 review note.
  // ---------------------------------------------------------------------------
  test(
    'CR-01 postMessage context rule fires on injected patterns; stays silent on clean code',
    () => {
      const FAKE = '/fake/src/routes/connect.tsx';

      // Fixture H: the three pre-fix production lines (OR-T2704 era).
      // 'password' appears on a line before postMessage(). The same-line rule
      // misses this; the context window rule catches it.
      const H = [
        'const msg: Record<string, unknown> = { type: "or-need-cred-key" };',
        'if (password) msg.password = password;',
        'opener.postMessage(msg, openerOrigin);',
      ].join('\n');

      // Fixture M: connect.tsx L297-300 with vaultPassword added to payload.
      const M = [
        'opener.postMessage(',
        '  { type: "or-need-cred-key", purpose: CRED_KEY_HANDOFF_PURPOSE, vaultPassword: vaultPassword },',
        '  openerOrigin,',
        ');',
      ].join('\n');

      // Fixture V: connect.tsx L1466-1480 with successPayload.vaultPassword
      // assigned before the send.
      const V = [
        '      const successPayload: Record<string, unknown> = {',
        '        type: "or-link-success",',
        '        source_wallets: enrichedSourceWallets,',
        '        subaccount_id: result.subaccount_id,',
        '        connection_id: result.connection_id,',
        '      };',
        '      if (enrichedSourceWallets.length === 1) {',
        '        const only = enrichedSourceWallets[0];',
        '        successPayload.sourceWalletId = only.id;',
        '        successPayload.currency = only.currency;',
        '        successPayload.walletName = only.label;',
        '        successPayload.externalId = only.external_wallet_id;',
        '      }',
        '      successPayload.vaultPassword = vaultPassword;',
        '      window.opener?.postMessage(successPayload, targetOrigin);',
      ].join('\n');

      // Red path: every injected fixture must produce at least 1 finding.
      expect(
        scanFileMultiLine(FAKE, H).length,
        'H (pre-fix lines: password on preceding line): expected >= 1 finding',
      ).toBeGreaterThan(0);
      expect(
        scanFileMultiLine(FAKE, M).length,
        'M (vaultPassword inside postMessage call): expected >= 1 finding',
      ).toBeGreaterThan(0);
      expect(
        scanFileMultiLine(FAKE, V).length,
        'V (successPayload.vaultPassword assigned before send): expected >= 1 finding',
      ).toBeGreaterThan(0);

      // Green path: same blocks without the injected identifier must be silent.

      // H-clean: remove the password assignment line.
      const H_CLEAN = [
        'const msg: Record<string, unknown> = { type: "or-need-cred-key" };',
        'opener.postMessage(msg, openerOrigin);',
      ].join('\n');
      expect(
        scanFileMultiLine(FAKE, H_CLEAN).length,
        'H-clean (no password line): expected 0 findings',
      ).toBe(0);

      // M-clean: connect.tsx L297-300 as currently written, no injected field.
      const M_CLEAN = [
        'opener.postMessage(',
        '  { type: "or-need-cred-key", purpose: CRED_KEY_HANDOFF_PURPOSE },',
        '  openerOrigin,',
        ');',
      ].join('\n');
      expect(
        scanFileMultiLine(FAKE, M_CLEAN).length,
        'M-clean (no vaultPassword): expected 0 findings',
      ).toBe(0);

      // V-clean: connect.tsx L1466-1480 as currently written, no injected assignment.
      const V_CLEAN = [
        '      const successPayload: Record<string, unknown> = {',
        '        type: "or-link-success",',
        '        source_wallets: enrichedSourceWallets,',
        '        subaccount_id: result.subaccount_id,',
        '        connection_id: result.connection_id,',
        '      };',
        '      if (enrichedSourceWallets.length === 1) {',
        '        const only = enrichedSourceWallets[0];',
        '        successPayload.sourceWalletId = only.id;',
        '        successPayload.currency = only.currency;',
        '        successPayload.walletName = only.label;',
        '        successPayload.externalId = only.external_wallet_id;',
        '      }',
        '      window.opener?.postMessage(successPayload, targetOrigin);',
      ].join('\n');
      expect(
        scanFileMultiLine(FAKE, V_CLEAN).length,
        'V-clean (no vaultPassword assignment): expected 0 findings',
      ).toBe(0);
    },
  );
});
