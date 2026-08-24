/**
 * Canonical builder for outbound webhook payloads.
 *
 * WHY THIS EXISTS. Before it, five separate places built a sync.completed
 * payload as an inline object literal, and they had drifted into three
 * different shapes:
 *
 *   or-sync (generic provider path)  flat fields AND { type, data }
 *   or-sync (two quiltt paths)       flat fields only
 *   or-quiltt-sync (two paths)       flat fields only, plus a `provider` field
 *
 * The consequence was not cosmetic. `@orangerails/webhooks`, the SDK we tell
 * integrators to use, reads `body.type` and throws
 * `Unsupported webhook event type: undefined` when it is absent. Four of the
 * five emitters produced a payload our own SDK could not parse, so an
 * integrator following our own documentation would have had every bank
 * notification throw while Bitcoin-source notifications parsed fine.
 *
 * Two of those five sites had already been fixed individually, for two
 * different missing fields, in two different PRs. Fixing literals one at a
 * time does not converge: a sixth site added tomorrow starts the drift again.
 * So the shape now lives in exactly one function and the call sites pass
 * values, not structure.
 *
 * THE DUAL SHAPE IS DELIBERATE AND TEMPORARY. Per the webhook architecture
 * decision of 2026-05-23, the SDK migration ships both wire formats in
 * parallel and drops the flat fields once every known consumer is on the SDK.
 * The flat fields are what hand-rolled receivers written before the SDK read;
 * removing them now would break every such receiver already in production.
 * `data` is what the SDK reads. They carry the same values, deliberately
 * duplicated.
 *
 * `data` matches `SyncCompletedEvent['data']` in packages/webhooks/src/types.ts
 * EXACTLY. Do not add fields to `data` without adding them to that type in the
 * same change, or the SDK's generated types will lie about the payload.
 */

/** Event names OR emits. Keep in step with EventType in packages/webhooks. */
export const SYNC_COMPLETED = 'sync.completed' as const;

export interface SyncCompletedInput {
  subaccountId: string;
  connectionId: string;
  /**
   * Rows OR pulled itself during this sync.
   *
   * Zero is a legitimate value, not a placeholder, on the event-driven sink
   * path: OR pulls nothing there, and the notification exists purely to tell
   * the integrator to come and call or-sync. Consumers must not read 0 as
   * "nothing happened" and skip their pull. It is always a number and is
   * never omitted; omitting it is what made a receiver silently drop events
   * while reporting success.
   */
  syncedCount: number;
  /**
   * Upstream provider, when the emitting path knows it.
   *
   * Deliberately flat-only: it is NOT copied into `data`, because `data` is
   * contractually the SDK's declared type and adding an undeclared field
   * there would make the published types wrong. A consumer that needs it can
   * read it off the top level, where it has always been. Whether it should be
   * promoted into the SDK type is a separate decision, tracked on DL-1565.
   */
  provider?: string;
  /** Override for tests. Production callers should omit it. */
  ts?: string;
}

/**
 * Build the wire payload for a sync.completed delivery.
 *
 * Returns both the legacy flat fields and the canonical { type, data } pair,
 * so a receiver on either side of the SDK migration can read it.
 */
export function buildSyncCompletedPayload(
  input: SyncCompletedInput,
): Record<string, unknown> {
  const ts = input.ts ?? new Date().toISOString();

  // Exactly SyncCompletedEvent['data']. Nothing else belongs in here.
  const data = {
    subaccount_id: input.subaccountId,
    connection_id: input.connectionId,
    synced_count: input.syncedCount,
    ts,
  };

  return {
    // Legacy flat shape. Read by receivers written before the SDK.
    event: SYNC_COMPLETED,
    ...(input.provider ? { provider: input.provider } : {}),
    ...data,
    // Canonical shape. Read by @orangerails/webhooks constructEvent().
    type: SYNC_COMPLETED,
    data,
  };
}
