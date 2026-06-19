import { describe, it, expect } from 'vitest';
import { buildWaveStagedPayload } from './to-staged-payload';
import { parseWaveAccountsJson } from './accounts-to-coa';
import { parseWavePartiesJson } from './parties-to-contacts';
import { assertStagedImportPayload, STAGED_IMPORT_CONTRACT_VERSION } from '../contract';

const ACCOUNTS_RAW = JSON.stringify([
  {
    node: {
      id: 'a1',
      name: 'Cash',
      displayId: '1010',
      description: null,
      isArchived: false,
      type: { name: 'Assets', normalBalanceType: 'DEBIT', value: 'ASSET' },
      subtype: { name: 'Cash', value: 'CASH' },
      currency: { code: 'CAD' },
    },
  },
  {
    node: {
      id: 'a2',
      name: 'Rent Income',
      displayId: '4000',
      description: null,
      isArchived: false,
      type: { name: 'Income', normalBalanceType: 'CREDIT', value: 'INCOME' },
      subtype: null,
      currency: { code: 'CAD' },
    },
  },
]);

const CUSTOMERS_RAW = JSON.stringify([
  {
    node: {
      id: 'c1',
      name: 'Acme',
      firstName: null,
      lastName: null,
      email: 'a@b.c',
      phone: null,
      mobile: null,
      isArchived: false,
      currency: null,
      address: null,
    },
  },
]);

const HEADER =
  'Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Amount (One column),Debit Amount,Credit Amount,Notes / Memo,Account ID';

describe('buildWaveStagedPayload', () => {
  it('emits a payload that passes the contract assertion', () => {
    const { payload } = buildWaveStagedPayload({
      accounts: parseWaveAccountsJson(ACCOUNTS_RAW),
      customers: parseWavePartiesJson(CUSTOMERS_RAW),
      vendors: [],
      files: [{ name: 'accounts.json', sizeBytes: ACCOUNTS_RAW.length }],
    });
    expect(() => assertStagedImportPayload(payload)).not.toThrow();
    expect(payload.contractVersion).toBe(STAGED_IMPORT_CONTRACT_VERSION);
    expect(payload.source.name).toBe('wave');
  });

  it('produces row objects keyed by V3 importer keys (name/code/type/...)', () => {
    const { payload } = buildWaveStagedPayload({
      accounts: parseWaveAccountsJson(ACCOUNTS_RAW),
      files: [],
    });
    const first = payload.staged.accounts?.[0];
    expect(first).toBeDefined();
    expect(Object.keys(first!)).toEqual(
      expect.arrayContaining([
        'name',
        'code',
        'type',
        'subtype',
        'normal_balance',
        'category',
        'description',
      ]),
    );
    expect(first!.type).toBe('ASSET');
  });

  it('omits journalEntries when no accounting.csv was provided', () => {
    const { payload } = buildWaveStagedPayload({
      accounts: parseWaveAccountsJson(ACCOUNTS_RAW),
      files: [],
    });
    expect(payload.staged.journalEntries).toBeUndefined();
    expect(payload.summary.journalEntries).toBe(0);
  });

  it('includes journal entries when accounting.csv is provided', () => {
    const wave = `${HEADER}\nTX1,2024-01-01,Cash,Rent,Rent,500.00,500.00,,,a1\nTX1,2024-01-01,Rent Income,Rent,Rent,-500.00,,500.00,,a2\n`;
    const { payload } = buildWaveStagedPayload({
      accounts: parseWaveAccountsJson(ACCOUNTS_RAW),
      accountingCsvText: wave,
      files: [{ name: 'accounting.csv', sizeBytes: wave.length }],
    });
    expect(payload.staged.journalEntries?.length).toBe(2);
    expect(payload.summary.journalEntries).toBe(1);
    expect(payload.summary.journalLines).toBe(2);
    const je0 = payload.staged.journalEntries![0];
    expect(je0['je_ref_#']).toBe('TX1');
    expect(je0.account_code).toBe('1010');
  });

  it('computes sha256 for files whose bytes are provided', () => {
    const bytes = new TextEncoder().encode('hello');
    const { payload } = buildWaveStagedPayload({
      accounts: parseWaveAccountsJson(ACCOUNTS_RAW),
      files: [{ name: 'x.json', sizeBytes: 5, bytes }],
    });
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(payload.manifest.files[0].sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
