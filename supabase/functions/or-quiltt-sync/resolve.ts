/**
 * Pure resolution helpers for or-quiltt-sync.
 *
 * index.ts calls Deno.serve at import time, so importing it from a test binds a
 * port. Everything here is the part of the drain that makes a decision; the
 * database calls stay in index.ts, which is the part that needs a client. Same
 * split as or-quiltt-webhook/routing.ts, and for the same reason.
 *
 * Five contract points, each pinned by a fixture in resolve.test.ts:
 *
 *   1. Routing already on the inbox row wins, and only when it is complete.
 *      A row carrying a subaccount but no platform is not routed, it is half
 *      written, and re-resolving it is cheaper than shipping a NULL onward.
 *   2. quiltt_profile_map is authoritative over profile metadata.
 *   3. platform_id is never read from the payload. It is read off the
 *      subaccounts row, so metadata naming a subaccount that does not exist
 *      resolves to nothing rather than to something wrong.
 *   4. The Quiltt profile id used for Basic auth is the profile that GENERATED
 *      the event. The map supplies it only when it agrees, or when the payload
 *      names no profile at all. See DL-0465: every profile minted before
 *      2026-06-10 has no map row and never will, and without this its events
 *      fail on `profile map missing` on every tick forever.
 *   5. A profile id taken off the payload is only usable when the payload also
 *      names the subaccount being processed. Without that check a row misrouted
 *      to the wrong subaccount authenticates successfully as the payload's
 *      profile and its transactions land under the wrong tenant.
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

export type ProfileIdSource =
  | 'map'
  | 'payload'
  | 'payload-rebound'
  | 'route-conflict'
  | 'none';

export interface ProfileIdChoice {
  profileId: string | null;
  source: ProfileIdSource;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Strip the identifying half of a provider id before it reaches a log.
 *
 * Same rule the GraphQL error path in index.ts applies to provider messages,
 * hoisted so a log line can use it directly. The type prefix survives so a
 * reader can still tell a profile from a connection; everything that names a
 * specific person does not. Prefix-agnostic on purpose, so it keeps working as
 * Quiltt adds id types, and case-insensitive because Quiltt ids are mixed case.
 */
export function redactProviderId(id: string): string {
  return id.replace(/\b([a-z]{2,8})_[A-Za-z0-9]{6,}\b/gi, '$1_[redacted]');
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
 * The credential has to belong to the profile that GENERATED the event. That is
 * the only profile whose Basic auth can read the connection the event refers to.
 * The map answers a different question, "which profile does this subaccount use
 * now", and the two answers are allowed to diverge.
 *
 * They diverge because the map gets read by two different keys. chooseRouting
 * reads it by profile id, so there it agrees with the payload by construction.
 * handleEvent reads it by subaccount_id, and a legacy subaccount that later
 * calls or-quiltt-session gets a BRAND NEW profile minted and mapped to it (see
 * the `mintBody` branch taken when that function's map lookup misses). Its
 * already-queued events still carry the old profile. Prefer the map there and
 * every one of them authenticates as a profile that cannot see its own
 * connection, and fails forever: the exact loop this file exists to end.
 *
 * So the map wins only when it agrees with the event, or when the event names no
 * profile at all. Otherwise the event's own profile wins, and the caller is
 * expected to say so loudly, because a rebound subaccount is worth a human look.
 *
 * DL-0465 is the no-map case: profiles minted before the map was ever written.
 * Those rows cannot be repaired here either, and not for want of trying:
 * quiltt_profile_map.quiltt_environment_id is NOT NULL and no webhook payload
 * carries an environment id, so there is nothing to insert.
 *
 * `routedSubaccountId` is what chooseRouting decided, and it is the reason this
 * function needs a third argument at all. Borrowing the payload's credential is
 * safe only while we agree with the payload about where its data belongs. A row
 * misrouted by the webhook receiver's old malformed-batch index shift carries a
 * COMPLETE stored route to the wrong subaccount, which chooseRouting trusts. The
 * map read by that wrong subaccount then returns some other profile, which looks
 * exactly like a rebind. Authenticate with the payload there and the credential
 * WORKS: it returns the real customer's transactions, and index.ts seals them
 * under the wrong subaccount's OPK and files them under the wrong tenant.
 *
 * Preferring the map in that case fails closed, because the map's profile cannot
 * read the payload's connection. So the payload is only allowed to supply a
 * credential when the profile metadata names the subaccount being processed. The
 * check covers BOTH payload paths: a misrouted row whose wrong subaccount simply
 * has no map row reaches the identical leak through 'payload' rather than
 * 'payload-rebound'.
 *
 * 'route-conflict' carries no profile id, so the caller fails the event rather
 * than guessing. That is the correct answer here even though it costs the event
 * a retry: a wrong tenant is not recoverable and a retry is.
 */
export function chooseProfileId(
  mapProfileId: unknown,
  ev: InboxEventLike,
  routedSubaccountId: unknown,
): ProfileIdChoice {
  const fromMap = str(mapProfileId);
  const fromPayload = profileIdFromPayload(ev);

  if (!fromPayload) {
    return fromMap
      ? { profileId: fromMap, source: 'map' }
      : { profileId: null, source: 'none' };
  }
  if (fromMap && fromMap === fromPayload) return { profileId: fromMap, source: 'map' };

  // Past here the credential would come off the payload, so the payload has to
  // corroborate the route before it is allowed to supply one.
  const routed = str(routedSubaccountId);
  if (!routed || metadataSubaccountId(ev) !== routed) {
    return { profileId: null, source: 'route-conflict' };
  }

  return fromMap
    ? { profileId: fromPayload, source: 'payload-rebound' }
    : { profileId: fromPayload, source: 'payload' };
}
