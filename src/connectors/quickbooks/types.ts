// V3 QuickBooks import types. Mirrors V2 shape but Prisma-free ,
// V3 stores accounts in `cala_account_map` where account_type /
// account_group are plain text columns. String literal unions keep the
// classifier output compatible with the V2 seed without pulling @prisma/client
// into the browser bundle.

export type QuickBooksFileType =
  | 'TRIAL_BALANCE'
  | 'JOURNAL'
  | 'CUSTOMERS'
  | 'VENDORS'
  | 'EMPLOYEES'
  | 'BALANCE_SHEET'
  | 'PROFIT_AND_LOSS'
  | 'GENERAL_LEDGER'
  | 'UNKNOWN';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export type AccountSubType =
  | 'WALLETS'
  | 'OTHER_CURRENT_ASSETS'
  | 'FIXED_ASSETS'
  | 'SUSPENSE'
  | 'CURRENT_LIABILITIES'
  | 'LONG_TERM_LIABILITIES'
  | 'OWNERS_EQUITY'
  | 'RETAINED_EARNINGS'
  | 'SALES'
  | 'COST_OF_SALES'
  | 'SALES_AND_MARKETING'
  | 'LABOR'
  | 'GENERAL_AND_ADMINISTRATIVE';

export type NormalBalance = 'DEBIT' | 'CREDIT';

export type ContactKind = 'CUSTOMER' | 'VENDOR' | 'EMPLOYEE';

export interface QuickBooksParseError {
  file?: string;
  row?: number;
  message: string;
}

export interface QuickBooksFileManifestItem {
  name: string;
  size: number;
  bytesHash: string;
  detectedType: QuickBooksFileType;
}

export interface ParsedTrialBalanceAccount {
  name: string;
  code: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface ParsedContact {
  name: string;
  kind: ContactKind;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
}

export interface ParsedJournalLine {
  accountName: string;
  accountCode: string | null;
  debit: string;
  credit: string;
  nativeCurrency: string | null;
  contactName: string | null;
  memo: string | null;
}

export interface ParsedJournalEntry {
  refNum: string;
  date: string;
  type: string | null;
  memo: string | null;
  lines: ParsedJournalLine[];
}

export interface ParsedValidationReportLine {
  accountName: string;
  amount: string;
  nativeCurrency: string | null;
}

export interface QuickBooksParsedData {
  trialBalanceAccounts: ParsedTrialBalanceAccount[];
  journalEntries: ParsedJournalEntry[];
  contacts: ParsedContact[];
  balanceSheetLines: ParsedValidationReportLine[];
  profitLossLines: ParsedValidationReportLine[];
  errors: QuickBooksParseError[];
}

export interface QuickBooksClassification {
  accountType: AccountType;
  accountSubType: AccountSubType;
  normalBalance: NormalBalance;
  isWallet: boolean;
  isSystem: boolean;
}

export interface QuickBooksClassificationResult {
  confident: Record<string, QuickBooksClassification>;
  ambiguous: string[];
}

export interface QuickBooksParseSummary {
  accounts: number;
  contacts: number;
  journalEntries: number;
  journalLines: number;
  ambiguous: string[];
  files: QuickBooksFileManifestItem[];
  missingRequired: string[];
  ratePendingLineCount?: number;
}

export interface QuickBooksReconciliationLine {
  accountName: string;
  nativeCurrency: string;
  trialBalance: string;
  imported: string;
  diff: string;
  baseImported?: string;
  baseDiff?: string;
  pendingRates?: number;
}

export interface QuickBooksStagedData extends QuickBooksParsedData {
  classifications: QuickBooksClassificationResult;
}
