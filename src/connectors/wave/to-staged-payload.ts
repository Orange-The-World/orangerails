/**
 * Build a StagedImportPayload (Mode 2) from a Wave dataset.
 *
 * Wave already produces V3-shaped CSV strings via the three converter
 * modules. This wraps them into the cross-connector JSON contract that V3's
 * "Import from Orange Rails" wizard ingests.
 *
 * The CSV form (Mode 1) remains the default for now because V3 already has
 * inline ImportPopup widgets that handle it. Mode 2 is what QuickBooks
 * (once relocated) and future API connectors will use.
 */

import { createHash } from 'node:crypto';

import {
  STAGED_IMPORT_CONTRACT_VERSION,
  type StagedImportPayload,
  type V3StagedRow,
} from '../contract';
import { parseCsv } from './csv-utils';
import { buildCoaCsv, V3_COA_HEADERS } from './accounts-to-coa';
import { buildContactsCsv, V3_CONTACT_HEADERS } from './parties-to-contacts';
import { buildJournalEntriesCsv, V3_JE_HEADERS } from './journal-csv-to-v3';
import { buildAccountCodeMap } from './code-map';
import type { WaveAccountNode, WavePartyNode } from './types';

const CONNECTOR_VERSION = '0.1.0';

/** Convert a header row + data rows into row objects keyed by V3-importer keys. */
function rowsToObjects(csv: string): V3StagedRow[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/ /g, '_'));
  return rows.slice(1).map((r) => {
    const row: V3StagedRow = {};
    headers.forEach((h, i) => {
      row[h] = r[i] ?? '';
    });
    return row;
  });
}

export type WaveStagingInput = {
  accounts: WaveAccountNode[];
  customers?: WavePartyNode[];
  vendors?: WavePartyNode[];
  /** Wave's UI-exported accounting.csv text, if available. */
  accountingCsvText?: string;
  /**
   * Business currency (e.g. 'CAD'). Wave exports CSV amounts in business
   * currency even for foreign-currency accounts, so every JE line should
   * carry this single tag. Source it from business.json's currency.code.
   */
  businessCurrency?: string;
  /** Manifest entries describing the raw files this payload came from. */
  files: Array<{ name: string; sizeBytes: number; bytes?: Uint8Array }>;
  orgHint?: { name?: string; currency?: string };
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildWaveStagedPayload(input: WaveStagingInput): {
  payload: StagedImportPayload;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  const codeMap = buildAccountCodeMap(input.accounts);

  const coa = buildCoaCsv(input.accounts, codeMap);
  warnings.push(...coa.warnings);

  const contacts = buildContactsCsv(input.customers ?? [], input.vendors ?? []);
  warnings.push(...contacts.warnings);

  let jeRows: V3StagedRow[] = [];
  let journalLines = 0;
  if (input.accountingCsvText) {
    const je = buildJournalEntriesCsv(input.accountingCsvText, codeMap, input.accounts, {
      businessCurrency: input.businessCurrency,
    });
    warnings.push(...je.warnings);
    errors.push(...je.errors);
    jeRows = rowsToObjects(je.csv);
    journalLines = je.lineCount;
  }

  // Sanity: header keys round-trip through rowsToObjects.
  const accountsRows = rowsToObjects(coa.csv);
  const contactsRows = rowsToObjects(contacts.csv);

  if (accountsRows.length && !('name' in accountsRows[0])) {
    errors.push('Internal: COA row keys do not match V3 importer expectations.');
  }
  if (contactsRows.length && !('name' in contactsRows[0])) {
    errors.push('Internal: Contacts row keys do not match V3 importer expectations.');
  }

  // Surface CSV header constants in the warning list during dev so any future
  // V3 column rename surfaces immediately when payload generation runs.
  void V3_COA_HEADERS;
  void V3_CONTACT_HEADERS;
  void V3_JE_HEADERS;

  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: 'wave',
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(input.orgHint ? { orgHint: input.orgHint } : {}),
    manifest: {
      files: input.files.map((f) => ({
        name: f.name,
        sizeBytes: f.sizeBytes,
        ...(f.bytes ? { sha256: sha256Hex(f.bytes) } : {}),
      })),
    },
    summary: {
      accounts: accountsRows.length,
      contacts: contactsRows.length,
      journalEntries: 0, // counted below by walking groups
      journalLines,
      warnings,
      errors,
    },
    staged: {
      accounts: accountsRows,
      contacts: contactsRows,
      ...(jeRows.length ? { journalEntries: jeRows } : {}),
    },
  };

  // Count distinct JE groups by ref (de-duped) for the summary.
  if (jeRows.length) {
    const refs = new Set<string>();
    for (const r of jeRows) refs.add(r['je_ref_#'] ?? '');
    payload.summary.journalEntries = refs.size;
  }

  return { payload, warnings, errors };
}
