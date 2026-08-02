/**
 * Pure routing logic for or-quiltt-webhook.
 *
 * Separate module for the same reason or-quiltt-accounts/transform.ts is
 * separate: index.ts calls Deno.serve at import time, so importing it in a
 * test binds a port as a side effect. Everything here is a plain function
 * over plain data, so the routing contract can be asserted with no server,
 * no database and no credential.
 *
 * The contract this exists to pin (DL-0465):
 *
 *   1. rows and their routing hints stay aligned even when malformed events
 *      are skipped. The previous implementation re-derived the profile as
 *      events[i] during annotation while rows[] had already dropped the
 *      malformed entries, so one skip shifted every later row onto its
 *      neighbour's profile and filed that event under the wrong subaccount.
 *   2. quiltt_profile_map wins when it has an answer.
 *   3. profile.metadata.or_subaccount_id is the fallback when it does not.
 *   4. platform_id is NEVER taken from the payload. Callers resolve it from
 *      the subaccounts table and pass the validated map in, so a metadata
 *      value naming a subaccount that does not exist resolves to nothing
 *      rather than to something wrong.
 */

export interface QuilttEventLike {
  id?: unknown;
  type?: unknown;
  profile?: { id?: unknown; metadata?: { or_subaccount_id?: unknown } | null };
}

export interface InboxRow {
  event_id: string;
  event_type: string;
  payload: unknown;
  platform_id: string | null;
  subaccount_id: string | null;
}

/** Routing hint for rows[i], carried alongside rather than recomputed. */
export interface RouteHint {
  profileId: string | null;
  metaSubaccountId: string | null;
}

export interface BuiltRows {
  rows: InboxRow[];
  hints: RouteHint[];
  profileIds: string[];
  metaSubaccountIds: string[];
}

export interface RoutingCounts {
  viaMap: number;
  viaMetadata: number;
  unrouted: number;
}

/**
 * Turn a raw Quiltt event batch into inbox rows plus aligned routing hints.
 *
 * Malformed events (missing id or type) are dropped. rows[i] and hints[i]
 * are pushed together, so they describe the same event by construction and
 * there is no index into `events` to get wrong.
 */
export function buildRows(events: QuilttEventLike[]): BuiltRows {
  const rows: InboxRow[] = [];
  const hints: RouteHint[] = [];
  const profileIds = new Set<string>();
  const metaSubaccountIds = new Set<string>();

  for (const e of events) {
    const eventId = typeof e?.id === 'string' ? e.id : null;
    const eventType = typeof e?.type === 'string' ? e.type : null;
    if (!eventId || !eventType) continue;

    const profileId = typeof e.profile?.id === 'string' ? e.profile.id : null;
    const metaSub = typeof e.profile?.metadata?.or_subaccount_id === 'string'
      ? e.profile.metadata.or_subaccount_id
      : null;

    if (profileId) profileIds.add(profileId);
    if (metaSub) metaSubaccountIds.add(metaSub);

    rows.push({
      event_id: eventId,
      event_type: eventType,
      payload: e,
      platform_id: null,
      subaccount_id: null,
    });
    hints.push({ profileId, metaSubaccountId: metaSub });
  }

  return {
    rows,
    hints,
    profileIds: [...profileIds],
    metaSubaccountIds: [...metaSubaccountIds],
  };
}

/**
 * Fill in platform_id / subaccount_id on each row, mutating rows in place
 * and returning how each was resolved.
 *
 * @param mapping      quiltt_profile_id -> {platform_id, subaccount_id}
 * @param metaResolved subaccount_id -> platform_id, already validated by the
 *                     caller against the subaccounts table. Passing an
 *                     unvalidated map here defeats the whole guard.
 */
export function applyRouting(
  rows: InboxRow[],
  hints: RouteHint[],
  mapping: Map<string, { platform_id: string; subaccount_id: string }>,
  metaResolved: Map<string, string>,
): RoutingCounts {
  let viaMap = 0;
  let viaMetadata = 0;
  let unrouted = 0;

  for (let i = 0; i < rows.length; i++) {
    const hint = hints[i];
    const map = hint?.profileId ? mapping.get(hint.profileId) : undefined;
    if (map) {
      rows[i].platform_id = map.platform_id;
      rows[i].subaccount_id = map.subaccount_id;
      viaMap++;
      continue;
    }

    const platformId = hint?.metaSubaccountId ? metaResolved.get(hint.metaSubaccountId) : undefined;
    if (platformId) {
      rows[i].platform_id = platformId;
      rows[i].subaccount_id = hint.metaSubaccountId;
      viaMetadata++;
      continue;
    }

    unrouted++;
  }

  return { viaMap, viaMetadata, unrouted };
}
