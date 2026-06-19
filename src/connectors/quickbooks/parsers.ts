import type {
  ContactKind,
  ParsedContact,
  ParsedJournalEntry,
  ParsedJournalLine,
  ParsedTrialBalanceAccount,
  ParsedValidationReportLine,
  QuickBooksParseError,
} from './types';
import {
  cellToString,
  columnIndex,
  findHeaderRow,
  firstWorksheet,
  loadWorkbook,
  parseMoney,
  worksheetRows,
  type WorkbookSource,
} from './workbook';

function splitCodeAndName(raw: string): { code: string | null; name: string } {
  const value = raw.trim();
  const match = value.match(/^([A-Za-z]?\d{2,})\s+(.+)$/);
  if (match) {
    return { code: match[1], name: match[2].trim() };
  }
  return { code: null, name: value };
}

function parseDate(value: string): string | null {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString().slice(0, 10);
  }
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const date = new Date(Date.UTC(Number(year), Number(match[1]) - 1, Number(match[2])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function refToken(value: string | null | undefined, fallback: string): string {
  const token = (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || fallback;
}

function buildJournalRefNum(args: {
  date: string;
  type: string | null;
  refRaw: string;
  sequence: number;
}): string {
  return [
    'QB',
    args.date.replace(/-/g, ''),
    refToken(args.type, 'ENTRY'),
    refToken(args.refRaw, String(args.sequence)),
    String(args.sequence),
  ].join('-');
}

export async function parseTrialBalance(
  source: WorkbookSource,
  file?: string,
): Promise<{ accounts: ParsedTrialBalanceAccount[]; errors: QuickBooksParseError[] }> {
  const workbook = await loadWorkbook(source);
  const rows = worksheetRows(firstWorksheet(workbook));
  // QB's Trial Balance export has no "Account" header in the first column , the
  // column is implicitly accounts. Detect the header row by the Debit/Credit
  // labels instead, and treat column 0 as the account name.
  const headerIndex = findHeaderRow(rows, ['debit', 'credit']);
  const errors: QuickBooksParseError[] = [];
  const accounts: ParsedTrialBalanceAccount[] = [];
  if (headerIndex === -1) {
    return { accounts, errors: [{ file, message: 'Trial Balance missing Debit/Credit headers.' }] };
  }

  const headers = rows[headerIndex];
  const accountLookup = columnIndex(headers, ['account', 'account name', 'name']);
  const accountIdx = accountLookup === -1 ? 0 : accountLookup;
  const debitIdx = columnIndex(headers, ['debit', 'debit amount']);
  const creditIdx = columnIndex(headers, ['credit', 'credit amount']);
  const balanceIdx = columnIndex(headers, ['balance', 'ending balance', 'amount']);

  rows.slice(headerIndex + 1).forEach((row, index) => {
    const rowNumber = headerIndex + index + 2;
    const account = row[accountIdx] ?? '';
    if (!account.trim() || /^total\b/i.test(account)) return;
    // QB appends an export-timestamp row at the bottom of reports, e.g.
    // "Tuesday, Apr 21, 2026 10:30:00 AM GMT-7 - Accrual Basis". Skip it.
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,\s+/i.test(account)) return;
    const { code, name } = splitCodeAndName(account);
    const debit = debitIdx === -1 ? '0' : parseMoney(row[debitIdx] ?? '');
    const credit = creditIdx === -1 ? '0' : parseMoney(row[creditIdx] ?? '');
    const balance = balanceIdx === -1
      ? String(Number(debit) - Number(credit))
      : parseMoney(row[balanceIdx] ?? '');
    if (!name) {
      errors.push({ file, row: rowNumber, message: 'Account name is empty.' });
      return;
    }
    accounts.push({ name, code, debit, credit, balance });
  });

  return { accounts, errors };
}

export async function parseContacts(
  source: WorkbookSource,
  kind: ContactKind,
  file?: string,
): Promise<{ contacts: ParsedContact[]; errors: QuickBooksParseError[] }> {
  const workbook = await loadWorkbook(source);
  const rows = worksheetRows(firstWorksheet(workbook));
  // QB's Customer/Vendor/Employee lists use the entity type as the column header
  // ("Customer", "Vendor", "Employee"), not literally "Name". Check any of them.
  let headerIndex = findHeaderRow(rows, ['customer']);
  if (headerIndex === -1) headerIndex = findHeaderRow(rows, ['vendor']);
  if (headerIndex === -1) headerIndex = findHeaderRow(rows, ['employee']);
  if (headerIndex === -1) headerIndex = findHeaderRow(rows, ['name']);
  const errors: QuickBooksParseError[] = [];
  const contacts: ParsedContact[] = [];
  if (headerIndex === -1) {
    return { contacts, errors: [{ file, message: 'Contact file missing Name / Customer / Vendor / Employee header.' }] };
  }

  const headers = rows[headerIndex];
  const nameIdx = columnIndex(headers, ['customer', 'vendor', 'employee', 'name']);
  const emailIdx = columnIndex(headers, ['email', 'email address']);
  const phoneIdx = columnIndex(headers, ['phone', 'phone number']);
  const streetIdx = columnIndex(headers, ['street', 'address', 'billing address']);
  const cityIdx = columnIndex(headers, ['city']);
  const stateIdx = columnIndex(headers, ['state']);
  const countryIdx = columnIndex(headers, ['country']);
  const zipIdx = columnIndex(headers, ['zip', 'postal code']);

  rows.slice(headerIndex + 1).forEach((row, index) => {
    const rowNumber = headerIndex + index + 2;
    const name = (row[nameIdx] ?? '').trim();
    if (!name) {
      errors.push({ file, row: rowNumber, message: 'Contact name is empty.' });
      return;
    }
    // Skip QB's export-timestamp footer row.
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,\s+/i.test(name)) return;
    if (/^total\b/i.test(name)) return;
    contacts.push({
      name,
      kind,
      email: emailIdx === -1 ? null : (row[emailIdx] || null),
      phone: phoneIdx === -1 ? null : (row[phoneIdx] || null),
      street: streetIdx === -1 ? null : (row[streetIdx] || null),
      city: cityIdx === -1 ? null : (row[cityIdx] || null),
      state: stateIdx === -1 ? null : (row[stateIdx] || null),
      country: countryIdx === -1 ? null : (row[countryIdx] || null),
      zip: zipIdx === -1 ? null : (row[zipIdx] || null),
    });
  });

  return { contacts, errors };
}

function buildJournalLine(
  row: string[],
  headers: string[],
): ParsedJournalLine | null {
  const accountIdx = columnIndex(headers, ['account', 'account name']);
  const debitIdx = columnIndex(headers, ['debit']);
  const creditIdx = columnIndex(headers, ['credit']);
  const amountIdx = columnIndex(headers, ['amount']);
  const currencyIdx = columnIndex(headers, ['currency', 'native currency']);
  const nameIdx = columnIndex(headers, ['name', 'contact', 'customer', 'vendor']);
  const memoIdx = columnIndex(headers, ['memo', 'description']);
  const accountRaw = accountIdx === -1 ? '' : row[accountIdx] ?? '';
  if (!accountRaw.trim()) return null;
  const { code, name } = splitCodeAndName(accountRaw);
  let debit = debitIdx === -1 ? '0' : parseMoney(row[debitIdx] ?? '');
  let credit = creditIdx === -1 ? '0' : parseMoney(row[creditIdx] ?? '');
  if (debit === '0' && credit === '0' && amountIdx !== -1) {
    const amount = Number(parseMoney(row[amountIdx] ?? ''));
    debit = amount >= 0 ? String(amount) : '0';
    credit = amount < 0 ? String(Math.abs(amount)) : '0';
  }
  return {
    accountName: name,
    accountCode: code,
    debit,
    credit,
    nativeCurrency: currencyIdx === -1 ? null : (row[currencyIdx] || null),
    contactName: nameIdx === -1 ? null : (row[nameIdx] || null),
    memo: memoIdx === -1 ? null : (row[memoIdx] || null),
  };
}

export async function parseJournal(
  source: WorkbookSource,
  file?: string,
): Promise<{ journalEntries: ParsedJournalEntry[]; errors: QuickBooksParseError[] }> {
  const workbook = await loadWorkbook(source);
  const worksheet = firstWorksheet(workbook);
  const rows = worksheetRows(worksheet);
  const headerIndex = findHeaderRow(rows, ['date', 'account']);
  const errors: QuickBooksParseError[] = [];
  const journalEntries: ParsedJournalEntry[] = [];
  if (headerIndex === -1) {
    return { journalEntries, errors: [{ file, message: 'Journal missing Date and Account headers.' }] };
  }

  const headers = rows[headerIndex];
  const dateIdx = columnIndex(headers, ['date']);
  const typeIdx = columnIndex(headers, ['type', 'transaction type']);
  const refIdx = columnIndex(headers, ['num', 'no', 'ref', 'ref num']);
  const memoIdx = columnIndex(headers, ['memo', 'description']);
  let current: ParsedJournalEntry | null = null;

  rows.slice(headerIndex + 1).forEach((row, index) => {
    const rowNumber = headerIndex + index + 2;
    // Skip QB's export-timestamp footer row. Its full weekday name parses
    // successfully as a JS Date, so it would otherwise open a new entry that
    // accumulates no lines and gets rejected by the `>=2 lines` DB guardrail.
    const firstCell = row[0] ?? '';
    const dateCell = row[dateIdx] ?? '';
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,\s+/i.test(firstCell)) return;
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,\s+/i.test(dateCell)) return;
    if (/^total\b/i.test(firstCell)) return;
    const date = parseDate(dateCell);
    const type = typeIdx === -1 ? null : (row[typeIdx] || null);
    // A new journal entry requires BOTH date and type populated.
    // QuickBooks repeats the date on continuation rows of a multi-line entry
    // but only sets the type on the first row. The previous `type || !current`
    // rule over-counted entries 3x because many rows have a date without a type.
    const isNewEntry = Boolean(date && type);

    if (isNewEntry) {
      if (current) journalEntries.push(current);
      const refRaw = refIdx === -1 ? '' : row[refIdx] ?? '';
      const sequence = journalEntries.length + 1;
      current = {
        refNum: buildJournalRefNum({
          date: date!,
          type,
          refRaw,
          sequence,
        }),
        date: date!,
        type,
        memo: memoIdx === -1 ? null : (row[memoIdx] || null),
        lines: [],
      };
    }

    const line = buildJournalLine(row, headers);
    if (!line) return;
    if (!current) {
      errors.push({ file, row: rowNumber, message: 'Journal line appeared before an entry date.' });
      return;
    }
    current.lines.push(line);
  });

  if (current) journalEntries.push(current);

  return {
    journalEntries: journalEntries.filter((entry) => entry.lines.length > 0),
    errors,
  };
}

export async function parseValidationReport(
  source: WorkbookSource,
  file?: string,
): Promise<{ lines: ParsedValidationReportLine[]; errors: QuickBooksParseError[] }> {
  const workbook = await loadWorkbook(source);
  const worksheet = firstWorksheet(workbook);
  const rows = worksheetRows(worksheet);
  // QB's Balance Sheet / P&L reports don't have an "Account" header , the first
  // column is an unlabeled account-name column and the amount column is headed
  // "Total". Detect either layout: try the Account+Amount header first, then
  // fall back to a row whose only label is Total.
  let headerIndex = findHeaderRow(rows, ['account']);
  let implicitFirstColumn = false;
  if (headerIndex === -1) {
    headerIndex = findHeaderRow(rows, ['total']);
    implicitFirstColumn = true;
  }
  if (headerIndex === -1) {
    return { lines: [], errors: [{ file, message: 'Report missing Account / Total header.' }] };
  }
  const headers = rows[headerIndex];
  const accountLookup = columnIndex(headers, ['account', 'account name', 'name']);
  const accountIdx = implicitFirstColumn || accountLookup === -1 ? 0 : accountLookup;
  const amountIdx = columnIndex(headers, ['amount', 'balance', 'total']);
  const currencyIdx = columnIndex(headers, ['currency']);
  const lines: ParsedValidationReportLine[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const accountName = (row[accountIdx] ?? '').trim();
    if (!accountName || /^total\b/i.test(accountName)) continue;
    const rawAmount = amountIdx === -1 ? '' : (row[amountIdx] ?? '');
    // Hierarchical BS/P&L rows with no amount are section headers
    // (e.g. "ASSETS", "Current Assets") , skip them.
    if (rawAmount === '') continue;
    lines.push({
      accountName,
      amount: parseMoney(rawAmount),
      nativeCurrency: currencyIdx === -1 ? null : (row[currencyIdx] || null),
    });
  }
  return { lines, errors: [] };
}

export async function readWorkbookCellText(source: WorkbookSource, row: number, column: number): Promise<string> {
  const workbook = await loadWorkbook(source);
  const worksheet = firstWorksheet(workbook);
  return cellToString(worksheet.getRow(row).getCell(column).value);
}
