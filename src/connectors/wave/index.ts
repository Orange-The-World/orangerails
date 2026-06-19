/**
 * Orange Rails , Wave Accounting connector
 *
 * Public surface: pure converters that take Wave dumps (JSON or CSV text)
 * and produce V3-shaped CSV text.
 *
 *   buildCoaCsv(accounts, codeMap)                    → COA CSV
 *   buildContactsCsv(customers, vendors)              → Contacts CSV
 *   buildJournalEntriesCsv(csv, codeMap, accounts)    → JE CSV
 *
 * The CLI entry point lives at scripts/wave-convert.ts.
 *
 * ZKA note: these converters are designed to run on the founder's box, not on
 * a shared server. Wave plaintext data must never leave the founder's machine
 * un-encrypted. Push to V3 happens via V3's existing import wizard, which
 * encrypts in the browser before storage.
 */

export { buildCoaCsv, parseWaveAccountsJson, V3_COA_HEADERS } from './accounts-to-coa';
export { buildContactsCsv, parseWavePartiesJson, V3_CONTACT_HEADERS } from './parties-to-contacts';
export { buildJournalEntriesCsv, V3_JE_HEADERS } from './journal-csv-to-v3';
export { buildAccountCodeMap } from './code-map';
export { unwrapNodes } from './types';
export { buildWaveStagedPayload } from './to-staged-payload';
export type { WaveStagingInput } from './to-staged-payload';
export type {
  WaveAccountNode,
  WavePartyNode,
  CodeMap,
} from './types';
