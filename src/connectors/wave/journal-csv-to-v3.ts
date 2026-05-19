/**
 * Wave accounting.csv → V3 Journal Entries CSV.
 *
 * V3 JE columns (from src/lib/csv/journal-entries.ts):
 *   JE date, JE ref #, JE memo, JE status, Account code, Account name,
 *   Line description, Wallet Currency, Debit, Credit
 *
 * V3 groups consecutive rows that share [date, ref, memo, status, currency].
 * So all V3 lines belonging to one Wave Transaction ID must:
 *   - sit adjacent to each other,
 *   - share an identical date / ref / memo / currency.
 *
 * Wave's two-column (Debit/Credit) layout is preferred over the one-column
 * Amount field — V3 wants explicit Dr/Cr columns.
 *
 * Currency is one per Wave transaction, picked from the first
 * ASSET / LIABILITY / EQUITY account in the group (with first-line
 * fallback). Wave records every transaction in one monetary currency;
 * the per-account currency tag in accounts.json is metadata for the
 * account itself, not for transactions touching it. Catch-all accounts
 * (Uncategorized Expense, Suspense) carry their own currency tag that
 * commonly disagrees with the actual transaction currency.
 *
 * The converter validates that each emitted group balances (sum(Debit) ===
 * sum(Credit)) per currency. Unbalanced groups are flagged as errors and
 * still emitted, since V3's importer will refuse them anyway and the founder
 * can see exactly which transactions need a manual fix.
 */

import { buildCsv, parseCsv } from './csv-utils';
import type { CodeMap, WaveAccountNode } from './types';

export const V3_JE_HEADERS = [
  'JE date',
  'JE ref #',
  'JE memo',
  'JE status',
  'Account code',
  'Account name',
  'Line description',
  'Wallet Currency',
  'Debit',
  'Credit',
] as const;

/**
 * Build a case-insensitive map: account name (lowercased+trimmed) → Wave ID.
 * The accounting.csv export's "Account ID" column is unreliable (83% empty
 * in real-world Wave data, and where populated it holds UI display codes
 * like "4020" — NOT the GraphQL node ID). Account Name is the only stable
 * join key between CSV and accounts.json.
 */
function buildNameLookup(accounts: WaveAccountNode[]): {
  byName: Map<string, string>;
  duplicates: string[];
} {
  const byName = new Map<string, string>();
  const dups = new Set<string>();
  for (const a of accounts) {
    const k = a.name.trim().toLowerCase();
    if (byName.has(k)) dups.add(a.name);
    else byName.set(k, a.id);
  }
  return { byName, duplicates: [...dups] };
}

/**
 * Wave's accounting.csv ships two slightly different header forms depending
 * on which export option you pick in the UI:
 *   - Plain:        "Debit Amount" / "Credit Amount"
 *   - Two-column:   "Debit Amount (Two Column Approach)" / "Credit Amount (Two Column Approach)"
 * Both are accepted. The matcher tries each candidate in order.
 */
const WAVE_HEADERS: Record<string, string[]> = {
  txId: ['transaction id'],
  txDate: ['transaction date'],
  accountName: ['account name'],
  accountId: ['account id'],
  txDescription: ['transaction description'],
  lineDescription: ['transaction line description'],
  debit: ['debit amount (two column approach)', 'debit amount'],
  credit: ['credit amount (two column approach)', 'credit amount'],
  notes: ['notes / memo', 'notes/memo'],
};

type Header = keyof typeof WAVE_HEADERS;

function buildHeaderIndex(headerRow: string[]): Record<Header, number> {
  const norm = headerRow.map((h) => h.trim().toLowerCase());
  const idx = {} as Record<Header, number>;
  for (const key of Object.keys(WAVE_HEADERS) as Header[]) {
    const candidates = WAVE_HEADERS[key];
    let found = -1;
    for (const c of candidates) {
      const i = norm.indexOf(c);
      if (i >= 0) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      throw new Error(
        `Wave CSV is missing required column (tried: ${candidates.join(' / ')}). Found: ${headerRow.join(', ')}`,
      );
    }
    idx[key] = found;
  }
  return idx;
}

type WaveLine = {
  txId: string;
  txDate: string;
  accountId: string;
  accountName: string;
  txDescription: string;
  lineDescription: string;
  debit: number;
  credit: number;
  notes: string;
};

function parseAmount(raw: string): number {
  const t = raw.replace(/,/g, '').trim();
  if (!t) return 0;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

function pickMemo(lines: WaveLine[]): string {
  for (const l of lines) {
    const n = l.notes.trim();
    if (n) return n;
  }
  for (const l of lines) {
    const d = l.txDescription.trim();
    if (d) return d;
  }
  return '';
}

export type JeResult = {
  csv: string;
  groupCount: number;
  lineCount: number;
  warnings: string[];
  errors: string[];
};

export function buildJournalEntriesCsv(
  waveCsvText: string,
  codeMap: CodeMap,
  accounts: WaveAccountNode[],
): JeResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Build accountId → metadata map for currency + type resolution.
  // Note: Wave's per-account currency is metadata for that account, not for
  // the transactions touching it. Each Wave transaction settles in ONE
  // currency — that of the primary monetary account in the group. Generic
  // catch-all accounts (Uncategorized Expense / Income, Suspense) carry
  // their own currency tag that may not match the actual tx currency.
  // Tx currency is therefore picked from the first ASSET / LIABILITY /
  // EQUITY account in each group (with first-line fallback).
  const accountCurrency = new Map<string, string>();
  const accountType = new Map<string, string>();
  for (const a of accounts) {
    accountCurrency.set(a.id, a.currency?.code ?? 'USD');
    accountType.set(a.id, a.type.value);
  }

  const MONETARY_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY']);
  function pickTxCurrency(lines: WaveLine[]): string {
    for (const l of lines) {
      const t = accountType.get(l.accountId);
      if (t && MONETARY_TYPES.has(t)) {
        const c = accountCurrency.get(l.accountId);
        if (c) return c;
      }
    }
    // Fallback: first line's account currency, or USD.
    return accountCurrency.get(lines[0]?.accountId ?? '') ?? 'USD';
  }

  // Build name → Wave-ID lookup. CSV "Account ID" is unreliable; Account
  // Name is the real join key.
  const { byName: nameToId, duplicates: nameDuplicates } = buildNameLookup(accounts);
  for (const dup of nameDuplicates) {
    warnings.push(`Account name "${dup}" appears more than once in accounts.json — JE lookups for it will pick the first.`);
  }

  const rows = parseCsv(waveCsvText);
  if (rows.length === 0) {
    return { csv: buildCsv([...V3_JE_HEADERS], []), groupCount: 0, lineCount: 0, warnings, errors };
  }
  const [headerRow, ...dataRows] = rows;
  const idx = buildHeaderIndex(headerRow);

  // Parse + group by Transaction ID (preserve first-seen order).
  const groupsOrder: string[] = [];
  const groups = new Map<string, WaveLine[]>();
  const unknownNames = new Set<string>();
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (r.every((c) => c === '')) continue;
    const accountName = (r[idx.accountName] ?? '').trim();
    // Resolve account by NAME (CSV "Account ID" col is unreliable, see header
    // doc above). If unknown, record once and proceed with empty accountId so
    // downstream code-map lookup surfaces a clean error per row.
    const resolvedId = nameToId.get(accountName.toLowerCase()) ?? '';
    if (accountName && !resolvedId && !unknownNames.has(accountName)) {
      unknownNames.add(accountName);
    }
    const line: WaveLine = {
      txId: (r[idx.txId] ?? '').trim(),
      txDate: (r[idx.txDate] ?? '').trim(),
      accountId: resolvedId,
      accountName,
      txDescription: (r[idx.txDescription] ?? '').trim(),
      lineDescription: (r[idx.lineDescription] ?? '').trim(),
      debit: parseAmount(r[idx.debit] ?? ''),
      credit: parseAmount(r[idx.credit] ?? ''),
      notes: (r[idx.notes] ?? '').trim(),
    };
    if (!line.txId) {
      warnings.push(`Row ${i + 2}: missing Transaction ID, skipped.`);
      continue;
    }
    if (!groups.has(line.txId)) {
      groups.set(line.txId, []);
      groupsOrder.push(line.txId);
    }
    groups.get(line.txId)!.push(line);
  }
  for (const name of unknownNames) {
    errors.push(`Account name "${name}" appears in accounting.csv but not in accounts.json — re-run wave-backup.py to refresh accounts.json.`);
  }

  // Emit V3 rows.
  const outRows: unknown[][] = [];
  let groupCount = 0;
  let lineCount = 0;

  for (const txId of groupsOrder) {
    const lines = groups.get(txId)!;
    const currency = pickTxCurrency(lines);
    const date = lines[0].txDate;
    const ref = txId;
    const memo = pickMemo(lines);
    const status = 'POSTED';

    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      const code = codeMap.get(l.accountId);
      if (!code) {
        errors.push(`Tx ${txId}: no code for account "${l.accountName}" (id ${l.accountId}).`);
      }
      outRows.push([
        date,
        ref,
        memo,
        status,
        code ?? '',
        l.accountName,
        l.lineDescription || l.txDescription,
        currency,
        l.debit ? l.debit.toFixed(2) : '',
        l.credit ? l.credit.toFixed(2) : '',
      ]);
      dr += l.debit;
      cr += l.credit;
      lineCount += 1;
    }
    // Round to 2dp before comparison so 0.1+0.2 doesn't false-positive.
    const drR = Math.round(dr * 100);
    const crR = Math.round(cr * 100);
    if (drR !== crR) {
      errors.push(
        `Tx ${ref}: unbalanced — Debit ${(drR / 100).toFixed(2)} ${currency} vs Credit ${(crR / 100).toFixed(2)} ${currency}.`,
      );
    }
    groupCount += 1;
  }

  return {
    csv: buildCsv([...V3_JE_HEADERS], outRows),
    groupCount,
    lineCount,
    warnings,
    errors,
  };
}
