/**
 * Orange Rails, LDK connector — the ZKA seal boundary.
 *
 * SCAFFOLD, pre-audit. This is the SAME boundary as `src/stealth/lib/seal.ts`,
 * with unchanged primitives (Auditor VERIFIED baseline, msg 918):
 *   - AES-256-GCM, fresh IV per envelope
 *   - client-supplied 32-byte key (from deriveOrLdkKey)
 *   - HMAC-SHA-256 blind index
 *   - zero server-side key handling
 *
 * Intent at implementation: import the audited primitives from the stealth
 * module rather than re-implement crypto here, so there is one seal
 * implementation under audit, not two.
 */

import type { BlindIndex, SealedEnvelope } from './types';

/**
 * Encrypt an LDK payload (ChannelMonitor blob or payment record) client-side.
 * The server only ever stores the returned SealedEnvelope.
 *
 * TODO(impl): delegate to the audited stealth seal primitive (AES-256-GCM,
 * fresh IV) once wiring lands. Stub keeps the boundary explicit.
 */
export async function sealEnvelope(
  _key: Uint8Array,
  _plaintext: Uint8Array,
): Promise<SealedEnvelope> {
  throw new Error('sealEnvelope: scaffold only. Pending (a)-(e) audit gate.');
}

/** Decrypt client-side. There is NO server-side counterpart to this function. */
export async function unsealEnvelope(
  _key: Uint8Array,
  _env: SealedEnvelope,
): Promise<Uint8Array> {
  throw new Error('unsealEnvelope: scaffold only. Client-side only, by design.');
}

/**
 * Compute the blind index for a channel from its funding outpoint.
 * HMAC-SHA-256(indexKey, funding_outpoint). Deterministic so updates to the
 * same channel collide on one row (enables the atomic compare-and-set upsert).
 */
export async function blindIndex(
  _indexKey: Uint8Array,
  _fundingOutpoint: string,
): Promise<BlindIndex> {
  throw new Error('blindIndex: scaffold only. Pending (a)-(e) audit gate.');
}
