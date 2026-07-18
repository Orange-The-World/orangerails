/**
 * Client-side LDK ChannelMonitor persistence.
 *
 * Implements the LDK Persister / chain::Watch contract with the ZKA rules:
 *   - seal for confidentiality (payload never leaves the client in plaintext)
 *   - monotonic update_id watermark for correctness (stale = funds-loss)
 *   - persist-before-ack: LDK is told "durable" only after the server confirms
 *   - stale detection by construction: refuse to operate on a monitor behind
 *     the client-held watermark
 *
 * The server (or-ldk-persist) stores SealedEnvelope + blind index only and
 * enforces update_id regression rejection at the DB level (see
 * supabase/migrations/*_ldk_channel_state.sql).
 */

import { sealEnvelope, unsealEnvelope, blindIndex, type SealedEnvelope } from "./seal";

export type PersistOutcome = "ACCEPTED" | "IDEMPOTENT_OK" | "REJECTED_STALE";

export interface ChannelMonitorBlob {
  funding_outpoint: string; // stable channel key, e.g. "<txid>:<vout>"
  update_id: number; // monotonic per channel
  monitor: unknown; // opaque LDK ChannelMonitor bytes, sealed before upload
}

export interface PersistResponse {
  outcome: PersistOutcome;
  stored_update_id: number;
}

/**
 * Seal a ChannelMonitor update and push it to or-ldk-persist. Returns only
 * after the server confirms durability (persist-before-ack). Callers MUST NOT
 * ack the update to LDK unless this resolves with ACCEPTED or IDEMPOTENT_OK.
 */
export async function persistMonitor(
  blob: ChannelMonitorBlob,
  keyB64: string,
  put: (bidx: string, updateId: number, env: SealedEnvelope) => Promise<PersistResponse>,
): Promise<PersistResponse> {
  const bidx = await blindIndex(blob.funding_outpoint, keyB64);
  const env = await sealEnvelope({ monitor: blob.monitor }, keyB64);
  const res = await put(bidx, blob.update_id, env);
  if (res.outcome === "REJECTED_STALE") {
    // The server holds a newer monitor than we tried to write: this is a
    // rollback/restore race. Do NOT ack to LDK.
    throw new StaleMonitorError(blob.funding_outpoint, blob.update_id, res.stored_update_id);
  }
  return res; // ACCEPTED or IDEMPOTENT_OK — safe to ack
}

/**
 * Restore guard: refuse to operate if the loaded monitor is behind the
 * highest-known watermark. Stale = hard stop, surfaced to the user, never
 * silent. (Criterion (e).)
 */
export function assertNotStale(loadedUpdateId: number, watermarkUpdateId: number): void {
  if (loadedUpdateId < watermarkUpdateId) {
    throw new StaleMonitorError("<restore>", loadedUpdateId, watermarkUpdateId);
  }
}

/** TODO(scaffold): unseal + validate on restore. */
export async function loadMonitor(env: SealedEnvelope, keyB64: string): Promise<unknown> {
  const { monitor } = await unsealEnvelope<{ monitor: unknown }>(env, keyB64);
  return monitor;
}

export class StaleMonitorError extends Error {
  constructor(
    readonly outpoint: string,
    readonly attempted: number,
    readonly stored: number,
  ) {
    super(
      `Stale ChannelMonitor for ${outpoint}: attempted update_id ${attempted} < stored ${stored}. ` +
        `Refusing to operate — broadcasting old channel state is a funds-loss event.`,
    );
    this.name = "StaleMonitorError";
  }
}
