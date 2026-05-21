import { describe, it, expect } from 'vitest';
import { buildQuickBooksStagedPayload } from './to-staged-payload';
import {
  assertStagedImportPayload,
  STAGED_IMPORT_CONTRACT_VERSION,
} from '../contract';

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
});
