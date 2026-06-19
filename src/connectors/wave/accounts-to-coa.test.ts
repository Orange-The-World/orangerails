import { describe, it, expect } from 'vitest';
import { buildCoaCsv, parseWaveAccountsJson, V3_COA_HEADERS } from './accounts-to-coa';
import { buildAccountCodeMap } from './code-map';

const SAMPLE = JSON.stringify([
  {
    node: {
      id: 'wave-id-asset-1',
      name: 'Cash on Hand',
      displayId: '1010',
      description: 'Till money',
      isArchived: false,
      type: { name: 'Assets', normalBalanceType: 'DEBIT', value: 'ASSET' },
      subtype: { name: 'Cash and Bank', value: 'CASH_AND_BANK' },
      currency: { code: 'CAD' },
    },
  },
  {
    node: {
      id: 'wave-id-revenue-1',
      name: 'Rental Income',
      displayId: null,
      description: null,
      isArchived: false,
      type: { name: 'Income', normalBalanceType: 'CREDIT', value: 'INCOME' },
      subtype: null,
      currency: { code: 'CAD' },
    },
  },
  {
    node: {
      id: 'wave-id-archived',
      name: 'Legacy Account',
      displayId: '9999',
      description: 'Old',
      isArchived: true,
      type: { name: 'Expenses', normalBalanceType: 'DEBIT', value: 'EXPENSE' },
      subtype: { name: 'Misc', value: 'MISC' },
      currency: null,
    },
  },
]);

describe('accounts-to-coa', () => {
  it('produces a V3-shaped COA CSV with correct headers', () => {
    const accts = parseWaveAccountsJson(SAMPLE);
    const code = buildAccountCodeMap(accts);
    const out = buildCoaCsv(accts, code);
    const lines = out.csv.trim().split('\n');
    expect(lines[0]).toBe(V3_COA_HEADERS.join(','));
    expect(out.rowCount).toBe(3);
  });

  it('uses Wave displayId when set, synthesizes deterministic codes otherwise', () => {
    const accts = parseWaveAccountsJson(SAMPLE);
    const map = buildAccountCodeMap(accts);
    expect(map.get('wave-id-asset-1')).toBe('1010');
    expect(map.get('wave-id-archived')).toBe('9999');
    const synth = map.get('wave-id-revenue-1');
    expect(synth).toMatch(/^W-\d{5}$/);
    // Stable across runs:
    const accts2 = parseWaveAccountsJson(SAMPLE);
    const map2 = buildAccountCodeMap(accts2);
    expect(map2.get('wave-id-revenue-1')).toBe(synth);
  });

  it('preserves Wave Type enum values', () => {
    const accts = parseWaveAccountsJson(SAMPLE);
    const out = buildCoaCsv(accts, buildAccountCodeMap(accts));
    expect(out.csv).toContain(',ASSET,');
    expect(out.csv).toContain(',INCOME,');
    expect(out.csv).toContain(',EXPENSE,');
  });

  it('marks archived accounts in description without dropping them', () => {
    const accts = parseWaveAccountsJson(SAMPLE);
    const out = buildCoaCsv(accts, buildAccountCodeMap(accts));
    expect(out.csv).toMatch(/Legacy Account.*\[archived\]/);
  });

  it('falls back to subtype.value when subtype.name is absent', () => {
    const raw = JSON.stringify([
      {
        node: {
          id: 'x',
          name: 'X',
          displayId: '1',
          description: null,
          isArchived: false,
          type: { name: 'Assets', normalBalanceType: 'DEBIT', value: 'ASSET' },
          subtype: { name: '', value: 'FALLBACK_VAL' },
          currency: { code: 'USD' },
        },
      },
    ]);
    const accts = parseWaveAccountsJson(raw);
    const out = buildCoaCsv(accts, buildAccountCodeMap(accts));
    expect(out.csv).toContain('FALLBACK_VAL');
  });
});
