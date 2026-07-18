/**
 * Build a StagedImportPayload (Mode 2) from a QuickBooks export bundle.
 *
 * Input: a set of QuickBooks .xlsx files (either pulled from a zip via
 * parseQuickBooksZip(), or fed in directly). Each file is fingerprinted to
 * detect which report it is, the matching parser pulls structured rows out,
 * the classifier categorises account names, then everything is shaped into
 * the standard contract every OR connector emits.
 *
 * V3's ImportPreviewRow.data key naming (lower_snake_case) is honoured so
 * V3 reuses its existing src/lib/csv/* validators with zero translation.
 */

import { createHash } from 'node:crypto';
import JSZip from 'jszip';

import {
  STAGED_IMPORT_CONTRACT_VERSION,
  type StagedImportPayload,
  type V3StagedRow,
} from '../contract';
import { fingerprintQuickBooksWorkbook, detectQuickBooksFileTypeFromRows } from './fingerprint';
import { loadWorkbook, worksheetRows, firstWorksheet } from './workbook';
import { parseTrialBalance, parseContacts, parseJournal } from './parsers';
import { classifyQuickBooksAccounts } from './classifyAccounts';
import type {
  ParsedContact,
  ParsedJournalEntry,
  ParsedTrialBalanceAccount,
  QuickBooksFileType,
  QuickBooksClassification,
} from './types';

const CONNECTOR_NAME = 'quickbooks';
const CONNECTOR_VERSION = '0.1.0';

const CONTACT_KIND_TO_V3: Record<ParsedContact['kind'], 'Customer' | 'Vendor' | 'Employee'> = {
  CUSTOMER: 'Customer',
  VENDOR: 'Vendor',
  EMPLOYEE: 'Employee',
};

const FRIENDLY_SUBTYPE: Record<string, string> = {
  WALLETS: 'Wallet',
  OTHER_CURRENT_ASSETS: 'Other Current Asset',
  FIXED_ASSETS: 'Fixed Asset',
  SUSPENSE: 'Suspense',
  CURRENT_LIABILITIES: 'Current Liability',
  LONG_TERM_LIABILITIES: 'Long Term Liability',
  OWNERS_EQUITY: 'Owners Equity',
  RETAINED_EARNINGS: 'Retained Earnings',
  SALES: 'Sales',
  COST_OF_SALES: 'Cost of Sales',
  SALES_AND_MARKETING: 'Sales and Marketing',
  LABOR: 'Labor',
  GENERAL_AND_ADMINISTRATIVE: 'General and Administrative',
};

export type QuickBooksStagingFile = {
  /** File name from the zip (or as provided), used for manifest + diagnostics. */
  name: string;
  /** Raw file bytes. */
  bytes: Uint8Array;
  /** Optional override; otherwise fingerprinted from contents. */
  detectedType?: QuickBooksFileType;
};

export type QuickBooksStagingInput = {
  files: QuickBooksStagingFile[];
  businessCurrency?: string;
  orgHint?: { name?: string; currency?: string };
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Unpack a QuickBooks export .zip into individual workbook files. */
export async function parseQuickBooksZip(zipBytes: Uint8Array): Promise<QuickBooksStagingFile[]> {
  const zip = await JSZip.loadAsync(zipBytes);
  const out: QuickBooksStagingFile[] = [];
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.xlsx$/i.test(f.name));
  for (const entry of entries) {
    const data = await entry.async('uint8array');
    out.push({ name: entry.name, bytes: data });
  }
  return out;
}

function trialBalanceToStagedAccounts(
  accounts: ParsedTrialBalanceAccount[],
  classifications: Record<string, QuickBooksClassification>,
): V3StagedRow[] {
  const rows: V3StagedRow[] = [];
  for (const a of accounts) {
    const cls = classifications[a.name];
    const subtypeRaw = cls?.accountSubType ?? '';
    rows.push({
      name: a.name,
      code: a.code ?? '',
      type: cls?.accountType ?? '',
      subtype: FRIENDLY_SUBTYPE[subtypeRaw] ?? subtypeRaw,
      normal_balance: cls?.normalBalance ?? (Number.parseFloat(a.debit) >= Number.parseFloat(a.credit) ? 'DEBIT' : 'CREDIT'),
      category: '',
      description: '',
    });
  }
  return rows;
}

function contactsToStagedContacts(contacts: ParsedContact[]): V3StagedRow[] {
  return contacts.map((c) => ({
    name: c.name,
    type: CONTACT_KIND_TO_V3[c.kind] ?? 'Other',
    email: c.email ?? '',
    phone: c.phone ?? '',
    street: c.street ?? '',
    city: c.city ?? '',
    state: c.state ?? '',
    country: c.country ?? '',
    zip: c.zip ?? '',
  }));
}

function journalEntriesToStagedJEs(
  entries: ParsedJournalEntry[],
  businessCurrency: string,
): { rows: V3StagedRow[]; lineCount: number } {
  const rows: V3StagedRow[] = [];
  let lineCount = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push({
        je_date: e.date,
        'je_ref_#': e.refNum,
        je_memo: e.memo ?? '',
        je_status: 'POSTED',
        account_code: l.accountCode ?? '',
        account_name: l.accountName,
        line_description: l.memo ?? '',
        wallet_currency: l.nativeCurrency ?? businessCurrency,
        debit: l.debit && Number.parseFloat(l.debit) ? l.debit : '',
        credit: l.credit && Number.parseFloat(l.credit) ? l.credit : '',
      });
      lineCount += 1;
    }
  }
  return { rows, lineCount };
}

export async function buildQuickBooksStagedPayload(input: QuickBooksStagingInput): Promise<{
  payload: StagedImportPayload;
  warnings: string[];
  errors: string[];
}> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const businessCurrency = input.businessCurrency ?? 'USD';

  // Fingerprint each file and route to the right parser. One file per type
  // is expected; extras of the same type are concatenated.
  const trialBalanceAccts: ParsedTrialBalanceAccount[] = [];
  const allContacts: ParsedContact[] = [];
  const allJournals: ParsedJournalEntry[] = [];
  const manifestEntries: StagedImportPayload['manifest']['files'] = [];

  for (const f of input.files) {
    manifestEntries.push({ name: f.name, sizeBytes: f.bytes.byteLength, sha256: sha256Hex(f.bytes) });
    const detected = f.detectedType ?? (await fingerprintQuickBooksWorkbook(f.bytes));
    try {
      if (detected === 'TRIAL_BALANCE') {
        const { accounts, errors: e } = await parseTrialBalance(f.bytes, f.name);
        trialBalanceAccts.push(...accounts);
        for (const err of e) errors.push(`${f.name}: ${err.message}`);
      } else if (detected === 'CUSTOMERS') {
        const { contacts, errors: e } = await parseContacts(f.bytes, 'CUSTOMER', f.name);
        allContacts.push(...contacts);
        for (const err of e) errors.push(`${f.name}: ${err.message}`);
      } else if (detected === 'VENDORS') {
        const { contacts, errors: e } = await parseContacts(f.bytes, 'VENDOR', f.name);
        allContacts.push(...contacts);
        for (const err of e) errors.push(`${f.name}: ${err.message}`);
      } else if (detected === 'EMPLOYEES') {
        const { contacts, errors: e } = await parseContacts(f.bytes, 'EMPLOYEE', f.name);
        allContacts.push(...contacts);
        for (const err of e) errors.push(`${f.name}: ${err.message}`);
      } else if (detected === 'JOURNAL') {
        const { journalEntries: entries, errors: e } = await parseJournal(f.bytes, f.name);
        allJournals.push(...entries);
        for (const err of e) errors.push(`${f.name}: ${err.message}`);
      } else {
        warnings.push(`${f.name}: fingerprint = ${detected} (not staged; reserved for future validation reports).`);
      }
    } catch (err: unknown) {
      errors.push(`${f.name}: parse failed , ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Classify accounts (uses name patterns).
  const allAccountNames = new Set<string>();
  for (const a of trialBalanceAccts) allAccountNames.add(a.name);
  for (const e of allJournals) for (const l of e.lines) allAccountNames.add(l.accountName);
  const classification = classifyQuickBooksAccounts([...allAccountNames]);

  if (classification.ambiguous.length) {
    warnings.push(
      `${classification.ambiguous.length} account name(s) could not be auto-classified , surface to user in wizard: ${classification.ambiguous.slice(0, 5).join(', ')}${classification.ambiguous.length > 5 ? '…' : ''}`,
    );
  }

  const accountsStaged = trialBalanceToStagedAccounts(trialBalanceAccts, classification.confident);
  const contactsStaged = contactsToStagedContacts(allContacts);
  const { rows: journalStaged, lineCount } = journalEntriesToStagedJEs(allJournals, businessCurrency);

  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: CONNECTOR_NAME,
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(input.orgHint ? { orgHint: input.orgHint } : {}),
    manifest: { files: manifestEntries },
    summary: {
      accounts: accountsStaged.length,
      contacts: contactsStaged.length,
      journalEntries: allJournals.length,
      journalLines: lineCount,
      warnings,
      errors,
    },
    staged: {
      ...(accountsStaged.length ? { accounts: accountsStaged } : {}),
      ...(contactsStaged.length ? { contacts: contactsStaged } : {}),
      ...(journalStaged.length ? { journalEntries: journalStaged } : {}),
    },
    reconciliation: {
      accountClassifications: Object.fromEntries(
        Object.entries(classification.confident).map(([name, cls]) => [
          name,
          { type: cls.accountType, subtype: cls.accountSubType, confidence: 1 },
        ]),
      ),
    },
  };

  return { payload, warnings, errors };
}
