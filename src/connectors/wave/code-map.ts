/**
 * Wave doesn't always set displayId on accounts. V3 needs a Code column to
 * link journal-entry lines back to chart-of-accounts rows. We build a stable,
 * deterministic Wave-account-ID → V3-code mapping once, then use the same
 * map when emitting both the COA CSV and the JE CSV.
 *
 * Strategy:
 *   1. If Wave's displayId is non-empty, use it (preserves the user's own codes).
 *   2. Otherwise generate "W-XXXXX" where XXXXX is a 5-digit non-cryptographic
 *      hash of the Wave account ID. Collisions are detected and resolved by
 *      bumping a suffix so the final map is guaranteed unique.
 *
 * The resulting map is deterministic for a given accounts.json — re-running
 * the converter yields identical codes.
 */

import type { CodeMap, WaveAccountNode } from './types';

function hash5(input: string): number {
  // FNV-1a, 32-bit, then mod 100000
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h % 100000;
}

export function buildAccountCodeMap(accounts: WaveAccountNode[]): CodeMap {
  const map: CodeMap = new Map();
  const used = new Set<string>();

  // First pass: honour explicit displayId values.
  for (const a of accounts) {
    const explicit = (a.displayId ?? '').trim();
    if (explicit && !used.has(explicit)) {
      map.set(a.id, explicit);
      used.add(explicit);
    }
  }

  // Second pass: synthesize codes for the rest.
  for (const a of accounts) {
    if (map.has(a.id)) continue;
    const base = hash5(a.id);
    let n = base;
    let attempt = 0;
    while (true) {
      const candidate = `W-${String(n).padStart(5, '0')}`;
      if (!used.has(candidate)) {
        map.set(a.id, candidate);
        used.add(candidate);
        break;
      }
      attempt += 1;
      n = (n + 1) % 100000;
      if (attempt > 100000) {
        throw new Error(`code-map: exhausted hash space for account ${a.id}`);
      }
    }
  }

  return map;
}
