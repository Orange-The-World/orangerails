/**
 * Cross-connector push contract.
 *
 * Every OR connector emits a StagedImportPayload that V3's "Import from
 * Orange Rails" wizard ingests. See contract.ts for the full type + mode
 * explainer.
 */

export {
  STAGED_IMPORT_CONTRACT_VERSION,
  assertStagedImportPayload,
} from './contract';
export type { StagedImportPayload, V3StagedRow } from './contract';
