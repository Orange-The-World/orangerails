/**
 * Orange Rails, LDK connector public surface.
 *
 * SCAFFOLD, pre-audit. See DESIGN.md for the full design + the Auditor
 * `(a)-(e)` gate this branch answers.
 *
 * Strategic role: LDK is the ZKA-native Lightning path — a library embedded in
 * the client that holds the node seed and signs on-device. It is the FIRST
 * connector mirrored onto the Stealth Sync client-derive / server-sealed
 * boundary. LND (an authenticated node endpoint that holds keys node-side)
 * ships later with its trust-surface carve-out documented user-facing.
 *
 * Unlike the CSV import connectors (coinbase/, quickbooks/), LDK does not emit
 * a StagedImportPayload — it is a stateful, self-custody sync connector. Its
 * public surface is the client key/seal boundary + the channel-state
 * persistence layer.
 */

export { deriveOrLdkKey, deriveOrLdkIndexKey, LDK_INFO } from './derive';
export { sealEnvelope, unsealEnvelope, blindIndex } from './seal';
export {
  classifyUpsert,
  persistChannelState,
  assertNotStale,
} from './persist';
export type { UpsertResponse } from './persist';
export type {
  SealedEnvelope,
  BlindIndex,
  ChannelStateRecord,
  PersistOutcome,
} from './types';
