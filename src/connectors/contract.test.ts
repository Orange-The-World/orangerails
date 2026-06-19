import { describe, it, expect } from 'vitest';
import {
  STAGED_IMPORT_CONTRACT_VERSION,
  assertStagedImportPayload,
  type StagedImportPayload,
} from './contract';

const MINIMAL: StagedImportPayload = {
  contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
  source: { name: 'wave', version: '0.1.0', exportedAt: '2026-05-19T15:00:00Z' },
  manifest: { files: [] },
  summary: {
    accounts: 0,
    contacts: 0,
    journalEntries: 0,
    journalLines: 0,
    warnings: [],
    errors: [],
  },
  staged: {},
};

describe('staged import contract', () => {
  it('accepts a minimal well-formed payload', () => {
    expect(() => assertStagedImportPayload(MINIMAL)).not.toThrow();
  });

  it('rejects a payload with the wrong contractVersion', () => {
    const bad = { ...MINIMAL, contractVersion: 99 };
    expect(() => assertStagedImportPayload(bad)).toThrow(/contractVersion/);
  });

  it('rejects a payload missing source', () => {
    const bad = { ...MINIMAL, source: undefined } as unknown;
    expect(() => assertStagedImportPayload(bad)).toThrow(/source/);
  });

  it('rejects a payload where staged.accounts is not an array', () => {
    const bad: unknown = { ...MINIMAL, staged: { accounts: 'oops' } };
    expect(() => assertStagedImportPayload(bad)).toThrow(/accounts.*array/);
  });

  it('accepts staged rows shaped like V3 CSV importer keys', () => {
    const payload: StagedImportPayload = {
      ...MINIMAL,
      summary: { ...MINIMAL.summary, accounts: 1, contacts: 1 },
      staged: {
        accounts: [
          {
            name: 'Cash on Hand',
            code: '1010',
            type: 'ASSET',
            subtype: 'Cash',
            normal_balance: 'DEBIT',
            category: '',
            description: 'Till',
          },
        ],
        contacts: [
          {
            name: 'Acme',
            type: 'Customer',
            email: 'a@b.c',
            phone: '',
            street: '',
            city: '',
            state: '',
            country: '',
            zip: '',
          },
        ],
      },
    };
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
  });

  it('rejects null / non-object input', () => {
    expect(() => assertStagedImportPayload(null)).toThrow();
    expect(() => assertStagedImportPayload('hello')).toThrow();
    expect(() => assertStagedImportPayload(42)).toThrow();
  });
});
