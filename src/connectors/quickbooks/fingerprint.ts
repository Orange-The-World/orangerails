import type { QuickBooksFileType } from './types';
import {
  firstWorksheet,
  loadWorkbook,
  rowValues,
  type WorkbookSource,
} from './workbook';

const REPORT_PATTERNS: Array<[QuickBooksFileType, RegExp]> = [
  ['TRIAL_BALANCE', /\btrial\s+balance\b/i],
  ['JOURNAL', /\bjournal\b/i],
  ['CUSTOMERS', /\bcustomer\s+(contact\s+)?list\b|\bcustomers\b/i],
  ['VENDORS', /\bvendor\s+(contact\s+)?list\b|\bvendors\b/i],
  ['EMPLOYEES', /\bemployee\s+(contact\s+)?list\b|\bemployees\b/i],
  ['BALANCE_SHEET', /\bbalance\s+sheet\b/i],
  ['PROFIT_AND_LOSS', /\bprofit\s+(and|&)\s+loss\b|\bp&l\b/i],
  ['GENERAL_LEDGER', /\bgeneral\s+ledger\b/i],
];

export function detectQuickBooksFileTypeFromRows(rows: string[][]): QuickBooksFileType {
  const sample = rows.slice(0, 6).flat().join(' ');
  for (const [type, pattern] of REPORT_PATTERNS) {
    if (pattern.test(sample)) return type;
  }
  return 'UNKNOWN';
}

export async function fingerprintQuickBooksWorkbook(source: WorkbookSource): Promise<QuickBooksFileType> {
  const workbook = await loadWorkbook(source);
  const worksheet = firstWorksheet(workbook);
  const rows = [1, 2, 3, 4, 5].map((rowNumber) => rowValues(worksheet, rowNumber));
  return detectQuickBooksFileTypeFromRows(rows);
}
