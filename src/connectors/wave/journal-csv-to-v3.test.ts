import { describe, it, expect } from 'vitest';
import { buildJournalEntriesCsv, V3_JE_HEADERS } from './journal-csv-to-v3';
import { buildAccountCodeMap } from './code-map';
import { parseWaveAccountsJson } from './accounts-to-coa';

const ACCOUNTS = parseWaveAccountsJson(
  JSON.stringify([
    {
      node: {
        id: 'acct-cash',
        name: 'Cash on Hand',
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
        id: 'acct-rev',
        name: 'Rental Income',
        displayId: '4000',
        description: null,
        isArchived: false,
        type: { name: 'Income', normalBalanceType: 'CREDIT', value: 'INCOME' },
        subtype: null,
        currency: { code: 'CAD' },
      },
    },
    {
      node: {
        id: 'acct-usd',
        name: 'USD Bank',
        displayId: '1020',
        description: null,
        isArchived: false,
        type: { name: 'Assets', normalBalanceType: 'DEBIT', value: 'ASSET' },
        subtype: null,
        currency: { code: 'USD' },
      },
    },
  ]),
);
const CODES = buildAccountCodeMap(ACCOUNTS);

const HEADER =
  'Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Amount (One column),Debit Amount,Credit Amount,Notes / Memo,Account ID';

describe('journal-csv-to-v3', () => {
  it('emits V3 JE headers', () => {
    const wave = `${HEADER}\nTX1,2024-01-15,Cash on Hand,Rent Jan,Rent,500.00,500.00,,Rent note,acct-cash\nTX1,2024-01-15,Rental Income,Rent Jan,Rent,-500.00,,500.00,Rent note,acct-rev\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.csv.split('\n')[0]).toBe(V3_JE_HEADERS.join(','));
  });

  it('groups Wave rows that share Transaction ID into one balanced V3 entry', () => {
    const wave = `${HEADER}\nTX1,2024-01-15,Cash on Hand,Rent Jan,Rent,500.00,500.00,,Rent note,acct-cash\nTX1,2024-01-15,Rental Income,Rent Jan,Rent,-500.00,,500.00,Rent note,acct-rev\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.groupCount).toBe(1);
    expect(out.lineCount).toBe(2);
    expect(out.errors).toEqual([]);
  });

  it('flags unbalanced transactions as errors', () => {
    const wave = `${HEADER}\nTX2,2024-02-01,Cash on Hand,Bad,Bad,100.00,100.00,,,acct-cash\nTX2,2024-02-01,Rental Income,Bad,Bad,-50.00,,50.00,,acct-rev\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0]).toMatch(/unbalanced/i);
  });

  it('splits mixed-currency transactions and suffixes the ref with currency', () => {
    const wave = `${HEADER}\nTX3,2024-03-01,Cash on Hand,FX,CAD leg,100.00,100.00,,,acct-cash\nTX3,2024-03-01,USD Bank,FX,USD leg,-100.00,,100.00,,acct-usd\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.warnings.some((w) => w.includes('mixed currencies'))).toBe(true);
    expect(out.csv).toContain('TX3:CAD');
    expect(out.csv).toContain('TX3:USD');
  });

  it('uses the Account ID to look up the V3 code (not Account Name)', () => {
    const wave = `${HEADER}\nTX4,2024-04-01,Cash on Hand,X,X,1.00,1.00,,,acct-cash\nTX4,2024-04-01,Rental Income,X,X,-1.00,,1.00,,acct-rev\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    // displayId values were 1010 and 4000.
    expect(out.csv).toContain(',1010,');
    expect(out.csv).toContain(',4000,');
  });

  it('falls back to Transaction Description when Line Description is empty', () => {
    const wave = `${HEADER}\nTX5,2024-05-01,Cash on Hand,Top-level desc,,1.00,1.00,,,acct-cash\nTX5,2024-05-01,Rental Income,Top-level desc,,-1.00,,1.00,,acct-rev\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.csv).toContain('Top-level desc');
  });

  it('errors when a Wave row references an unknown Account ID', () => {
    const wave = `${HEADER}\nTX6,2024-06-01,Mystery,X,X,1.00,1.00,,,acct-missing\nTX6,2024-06-01,Cash on Hand,X,X,-1.00,,1.00,,acct-cash\n`;
    const out = buildJournalEntriesCsv(wave, CODES, ACCOUNTS);
    expect(out.errors.some((e) => e.includes('no code for account'))).toBe(true);
  });

  it('rejects a Wave CSV missing required columns', () => {
    const wave = 'Transaction ID,Transaction Date\nTX1,2024-01-01\n';
    expect(() => buildJournalEntriesCsv(wave, CODES, ACCOUNTS)).toThrow(/missing required column/);
  });
});
