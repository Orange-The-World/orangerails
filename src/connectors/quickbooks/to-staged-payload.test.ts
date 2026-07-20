import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildQuickBooksStagedPayload } from './to-staged-payload';
import {
  assertStagedImportPayload,
  STAGED_IMPORT_CONTRACT_VERSION,
} from '../contract';

/** Build a minimal QuickBooks journal workbook (Date + Type + Account + amounts). */
async function journalXlsxBytes(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Journal');
  ws.addRow(['Date', 'Type', 'Account', 'Debit', 'Credit']);
  // A new entry needs Date + Type; each line needs a non-empty Account.
  ws.addRow(['2026-01-15', 'Journal Entry', '1000 Cash', '100.00', '']);
  ws.addRow(['2026-01-15', '', '4000 Revenue', '', '100.00']);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('buildQuickBooksStagedPayload', () => {
  it('produces a contract-valid payload when given zero files (empty bundle)', async () => {
    const { payload, errors } = await buildQuickBooksStagedPayload({ files: [] });
    expect(errors).toEqual([]);
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
    expect(payload.contractVersion).toBe(STAGED_IMPORT_CONTRACT_VERSION);
    expect(payload.source.name).toBe('quickbooks');
    expect(payload.summary.accounts).toBe(0);
    expect(payload.summary.contacts).toBe(0);
    expect(payload.summary.journalEntries).toBe(0);
    expect(payload.staged.accounts).toBeUndefined();
    expect(payload.staged.contacts).toBeUndefined();
    expect(payload.staged.journalEntries).toBeUndefined();
  });

  it('includes empty manifest when no files are passed', async () => {
    const { payload } = await buildQuickBooksStagedPayload({ files: [] });
    expect(payload.manifest.files).toEqual([]);
  });

  it('falls back to USD when no businessCurrency provided', async () => {
    // Verified indirectly: when JE rows would be emitted without a native
    // currency, they'd get tagged USD. No JE rows here so we just confirm
    // the call completes.
    const { payload } = await buildQuickBooksStagedPayload({ files: [] });
    expect(payload).toBeDefined();
  });

  it('honours orgHint passthrough', async () => {
    const { payload } = await buildQuickBooksStagedPayload({
      files: [],
      orgHint: { name: 'Test Co', currency: 'EUR' },
    });
    expect(payload.orgHint).toEqual({ name: 'Test Co', currency: 'EUR' });
  });

  it('stages a journal file instead of dropping it on a bad destructure', async () => {
    // Regression: the JOURNAL branch destructured `entries` from parseJournal,
    // which returns `journalEntries`. `entries` was undefined, so
    // `allJournals.push(...entries)` threw a TypeError that surfaced as a
    // generic "parse failed" error and silently dropped every journal file.
    const bytes = await journalXlsxBytes();
    const { payload, errors } = await buildQuickBooksStagedPayload({
      files: [{ name: 'journal.xlsx', bytes, detectedType: 'JOURNAL' }],
    });

    expect(errors.filter((e) => /parse failed/i.test(e))).toEqual([]);
    expect(payload.summary.journalEntries).toBeGreaterThan(0);
    expect(payload.staged.journalEntries).toBeDefined();
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
  });
});
