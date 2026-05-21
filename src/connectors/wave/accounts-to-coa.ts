/**
 * Wave accounts.json → V3 Chart-of-Accounts CSV.
 *
 * V3 COA columns (from src/lib/csv/chart-of-accounts.ts):
 *   Name, Code, Type, SubType, Normal Balance, Category, Description
 *
 * Mapping:
 *   Name           ← Wave node.name
 *   Code           ← buildAccountCodeMap(...) lookup (displayId preserved when set)
 *   Type           ← Wave node.type.value (already ASSET / LIABILITY / EQUITY / INCOME / EXPENSE)
 *   SubType        ← Wave node.subtype.name  (human-readable; falls back to subtype.value)
 *   Normal Balance ← Wave node.type.normalBalanceType (DEBIT/CREDIT)
 *   Category       ← blank (Wave does not expose this; V3 importer leaves it optional)
 *   Description    ← Wave node.description, suffixed with " [archived]" when isArchived
 *
 * Archived accounts ARE included: Wave's CSV transaction history references
 * them, so the V3 JE importer needs them present in the COA. The marker in
 * Description gives the founder visibility to filter/clean up post-import.
 */

import { buildCsv } from './csv-utils';
import type { CodeMap, WaveAccountNode } from './types';
import { unwrapNodes } from './types';

export const V3_COA_HEADERS = [
  'Name',
  'Code',
  'Type',
  'SubType',
  'Normal Balance',
  'Category',
  'Description',
] as const;

export type CoaResult = {
  csv: string;
  rowCount: number;
  warnings: string[];
};

export function buildCoaCsv(accounts: WaveAccountNode[], codeMap: CodeMap): CoaResult {
  const warnings: string[] = [];
  const rows = accounts.map((a) => {
    const code = codeMap.get(a.id);
    if (!code) {
      warnings.push(`No code mapped for account ${a.id} (${a.name})`);
    }
    const subtype = (a.subtype?.name?.trim() || a.subtype?.value?.trim()) ?? '';
    const descBase = (a.description ?? '').trim();
    const archivedTag = a.isArchived ? '[archived]' : '';
    const description = [descBase, archivedTag].filter(Boolean).join(' ');
    return [
      a.name,
      code ?? '',
      a.type.value,
      subtype,
      a.type.normalBalanceType,
      '',
      description,
    ];
  });
  return {
    csv: buildCsv([...V3_COA_HEADERS], rows),
    rowCount: rows.length,
    warnings,
  };
}

/** Convenience: parses raw JSON text from Wave's accounts.json dump. */
export function parseWaveAccountsJson(raw: string): WaveAccountNode[] {
  return unwrapNodes<WaveAccountNode>(JSON.parse(raw));
}
