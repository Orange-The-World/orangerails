/**
 * Pure resolution helpers for or-quiltt-sync.
 *
 * index.ts calls Deno.serve at import time, so importing it from a test binds a
 * port. Everything here is the part of the drain that makes a decision; the
 * database calls stay in index.ts, which is the part that needs a client. Same
 * split as or-quiltt-webhook/routing.ts, and for the same reason.
 *
 * Four contract points, each pinned by a fixture in resolve.test.ts:
 *
 *   1. Routing already on the inbox row wins, and only when it is complete.
 *      A row carrying a subaccount but no platform is not routed, it is half
 *      written, and re-resolving it is cheaper than shipping a NULL onward.
 *   2. quiltt_profile_map is authoritative over profile metadata.
 *   3. platform_id is never read from the payload. It is read off the
 *      subaccounts row, so metadata naming a subaccount that does not exist
 *      resolves to nothing rather than to something wrong.
 *   4. The Quiltt profile id used for Basic auth prefers the map row and falls
 *      back to the payload only when there is no map row at all. See DL-0465:
 *      every profile minted before 2026-06-10 has no map row and never will,
 *      and without this fallback its events fail on `profile map missing` on
 *      every tick forever.
 */

export interface InboxEventLike {
  platform_id: string | null;
  subaccount_id: string | null;
  payload?: {
    profile?: {
      id?: unknown;
      metadata?: { or_subaccount_id?: unknown } | null;
    } | null;
  } | null;
}

/** A row from quiltt_profile_map, or null when the lookup found nothing. */
export interface MapRow {
  platform_id?: unknown;
  subaccount_id?: unknown;
  quiltt_profile_id?: unknown;
}

/** A row from subaccounts, looked up by the id the profile metadata named. */
export interface SubaccountRow {
  id?: unknown;
  platform_id?: unknown;
}

export type RoutingSource = 'inbox' | 'map' | 'metadata' | 'unresolved';

export interface Routing {
  platform_id: string | null;
  subaccount_id: string | null;
  source: RoutingSource;
}

export type ProfileIdSource = 'map' | 'payload' | 'none';

export interface ProfileIdChoice {
  profileId: string | null;
  source: ProfileIdSource;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The Quiltt profile id the webhook payload claims. Never a platform decision. */
export function profileIdFromPayload(ev: InboxEventLike): string | null {
  return str(ev?.payload?.profile?.id);
}

/** The subaccount id OR stamped into the Quiltt profile metadata at mint time. */
export function metadataSubaccountId(ev: InboxEventLike): string | null {
  return str(ev?.payload?.profile?.metadata?.or_subaccount_id);
}

/**
 * Decide where an inbox event belongs.
 *
 * `mapRow` is the quiltt_profile_map lookup by the payload's profile id, and
 * `subRow` is the subaccounts lookup by the metadata subaccount id. Either may
 * be null for "the query found nothing".
 */
export function chooseRouting(
  ev: InboxEventLike,
  mapRow: MapRow | null,
  subRow: SubaccountRow | null,
): Routing {
  const onRow = { platform: str(ev?.platform_id), subaccount: str(ev?.subaccount_id) };
  if (onRow.platform && onRow.subaccount) {
    return { platform_id: onRow.platform, subaccount_id: onRow.subaccount, source: 'inbox' };
  }

  const mapPlatform = str(mapRow?.platform_id);
  const mapSubaccount = str(mapRow?.subaccount_id);
  if (mapPlatform && mapSubaccount) {
    return { platform_id: mapPlatform, subaccount_id: mapSubaccount, source: 'map' };
  }

  // The metadata path. The subaccount row is the authority for platform_id, and
  // it must be the row the metadata actually named: a lookup that came back
  // with some other subaccount is a caller bug, not a routing answer.
  const metaSub = metadataSubaccountId(ev);
  const subId = str(subRow?.id);
  const subPlatform = str(subRow?.platform_id);
  if (metaSub && subId === metaSub && subPlatform) {
    return { platform_id: subPlatform, subaccount_id: subId, source: 'metadata' };
  }

  return { platform_id: null, subaccount_id: null, source: 'unresolved' };
}

/**
 * Pick the Quiltt profile id to authenticate the data pull with.
 *
 * The map row wins whenever it exists. The payload is consulted only when it
 * does not, which is the DL-0465 cohort: profiles minted before the profile map
 * was ever written. Those rows cannot be repaired by this function either, and
 * not for want of trying: quiltt_profile_map.quiltt_environment_id is NOT NULL
 * and no webhook payload carries an environment id, so there is nothing to
 * insert. Falling back is the only way their events ever drain.
 */
export function chooseProfileId(
  mapProfileId: unknown,
  ev: InboxEventLike,
): ProfileIdChoice {
  const fromMap = str(mapProfileId);
  if (fromMap) return { profileId: fromMap, source: 'map' };

  const fromPayload = profileIdFromPayload(ev);
  if (fromPayload) return { profileId: fromPayload, source: 'payload' };

  return { profileId: null, source: 'none' };
}
