/**
 * Orange Rails, LDK connector — channel-state persistence layer.
 *
 * SCAFFOLD, pre-audit. This is the correctness half of the design (DESIGN.md
 * §3): "seal for confidentiality, watermark for correctness". Answers Auditor
 * criterion (e).
 *
 * Two invariants, both non-negotiable:
 *   1. Persist-before-ack: we ack a ChannelMonitor update to LDK ONLY after the
 *      sealed blob is durably stored server-side. A lost/stale monitor is
 *      funds-loss, not a privacy bug.
 *   2. Monotonic watermark: the server accepts a write only if its update_id is
 *      strictly greater than the stored one. Enforced by an atomic DB
 *      compare-and-set (NOT read-check-write), so concurrent restores cannot
 *      race. See supabase/functions/or-ldk-channel-state.
 */

import type { ChannelStateRecord, PersistOutcome, SealedEnvelope } from './types';

/**
 * Server response to the atomic upsert. `returnedUpdateId` is the value from
 * the SQL RETURNING clause (present only when a row was written). When absent,
 * the caller reads back the stored update_id to classify the outcome — this is
 * a classification read, NOT a second write gate (Auditor msg 924).
 */
export type UpsertResponse = {
  returnedUpdateId?: number;
  storedUpdateId?: number;
};

/**
 * Classify an atomic-upsert response into a PersistOutcome.
 *
 *   row returned                 -> ACCEPTED
 *   no row + stored == requested -> IDEMPOTENT_OK   (persist-before-ack retry)
 *   no row + stored >  requested -> REJECTED_STALE  (rollback/restore race)
 *
 * Strictly-less-than is the only reject. Equal is always success, so a
 * legitimate retry after a crash never wedges the node.
 *
 * This function is pure and IS covered by persist.test.ts — the crypto/DB
 * wiring around it is the scaffolded part.
 */
export function classifyUpsert(
  requestedUpdateId: number,
  res: UpsertResponse,
): PersistOutcome {
  if (res.returnedUpdateId !== undefined) {
    return { kind: 'ACCEPTED', updateId: res.returnedUpdateId };
  }
  if (res.storedUpdateId === undefined) {
    throw new Error(
      'classifyUpsert: empty RETURNING requires a storedUpdateId read-back to classify.',
    );
  }
  if (res.storedUpdateId === requestedUpdateId) {
    return { kind: 'IDEMPOTENT_OK', updateId: requestedUpdateId };
  }
  // storedUpdateId > requestedUpdateId (stored < requested is impossible:
  // the atomic write would have accepted it).
  return { kind: 'REJECTED_STALE', storedUpdateId: res.storedUpdateId };
}

/**
 * Persist a sealed ChannelMonitor and return the classified outcome. The
 * caller acks to LDK only on ACCEPTED or IDEMPOTENT_OK; REJECTED_STALE is a
 * hard stop surfaced to the user (no chain broadcast, no channel resume).
 *
 * TODO(impl): POST the sealed record to or-ldk-channel-state, then classify.
 */
export async function persistChannelState(
  _record: ChannelStateRecord,
): Promise<PersistOutcome> {
  throw new Error('persistChannelState: scaffold only. Pending (a)-(e) audit gate.');
}

/**
 * Restore guard: refuse to operate if the loaded monitor is behind the
 * client-held watermark. Stale = hard stop, never silent (DESIGN.md §3).
 */
export function assertNotStale(loadedUpdateId: number, watermark: number): void {
  if (loadedUpdateId < watermark) {
    throw new Error(
      `Stale ChannelMonitor: loaded update_id ${loadedUpdateId} < watermark ${watermark}. ` +
        'Refusing to operate — broadcasting old channel state is a funds-loss event.',
    );
  }
}

export type { SealedEnvelope };
