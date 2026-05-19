/**
 * Orange Rails — QuickBooks connector.
 *
 * Reads QuickBooks Desktop / Online export files (8 .xlsx workbooks shipped
 * as a zip, or dropped individually) and produces a StagedImportPayload that
 * V3's "Import from Orange Rails" wizard ingests.
 *
 * Pure modules (types, workbook, fingerprint, classifyAccounts, parsers)
 * originated in V3's src/lib/imports/quickbooks/. They moved here as the
 * canonical home in commit <pending>. V3 keeps its own copy + commit.ts
 * until the V3 wizard is rewired to consume staged-import.json — at which
 * point V3's copies get deleted.
 *
 * ZKA boundary: runs on the founder's machine, never on a shared server.
 * Output payload is plaintext locally; V3 encrypts on upload.
 */

export * from './types';
export {
  loadWorkbook,
  firstWorksheet,
  worksheetRows,
  cellToString,
  parseMoney,
  type WorkbookSource,
} from './workbook';
export { fingerprintQuickBooksWorkbook, detectQuickBooksFileTypeFromRows } from './fingerprint';
export {
  parseTrialBalance,
  parseContacts,
  parseJournal,
  parseValidationReport,
} from './parsers';
export { classifyQuickBooksAccounts } from './classifyAccounts';
export {
  buildQuickBooksStagedPayload,
  parseQuickBooksZip,
  type QuickBooksStagingInput,
  type QuickBooksStagingFile,
} from './to-staged-payload';
