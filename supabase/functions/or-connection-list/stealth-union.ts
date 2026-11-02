/**
 * Stealth rows, projected into the or-connection-list shape.
 *
 * WHY THIS EXISTS. OrangeRails keeps two disjoint connection stores.
 * Normal providers land in `connections` (+ `source_wallets`), scoped by
 * `subaccount_id`. Stealth Sync (xpub, Sparrow) lands in
 * `stealth_connections`, scoped by `(platform_id, app_user_id)`, and is
 * reachable only through the `or-stealth-*` family.
 *
 * A host app that calls one list endpoint therefore cannot see a connection
 * its own user completed. Not a rendering bug: the completed connection is
 * invisible by construction, because nothing the app calls reads that store.
 *
 * The contract this restores, stated as an outcome:
 *
 *   or-connection-list returns every connection the user completed, in one
 *   shape, regardless of provider family.
 *
 * Additive only. No write path changes, no shadow rows in `connections`, no
 * migration. The keys already join: `subaccounts(id, platform_id,
 * external_user_id)` maps a subaccount to the pair the stealth store is
 * keyed by.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never surfaces `sealed_envelope`,
 * in any field, under any name. Shape parity is not key parity: the envelope
 * is sealed to a key the consuming app holds and the ORK cannot open, so a
 * consumer that found ciphertext in `encrypted_credentials` and tried an ORK
 * decrypt on it would be doing precisely the wrong thing. The credential
 * fields are null, which is a fact about this row, not a placeholder.
 */

import { computeSyncFreshness } from '../_shared/sync-freshness.ts';
import type { SyncFreshnessFields } from '../_shared/sync-freshness.ts';

/** Columns read from `stealth_connections`. No envelope column, on purpose. */
export interface StealthConnectionRow {
  id: string;
  connection_kind: string;
  status: string;
  last_sync_at: string | null;
  last_block_scanned: number | null;
  created_at: string;
}

/**
 * The one shape. Every consumer of or-connection-list already reads these
 * fields off a regular row; a stealth row now answers to the same names.
 */
export interface UnifiedConnection {
  id: string;
  provider_type: string;
  /**
   * Branch on this, never on a provider-name list. A growing set of stealth
   * kinds must not require every consumer to learn each new name.
   */
  is_stealth: boolean;
  encrypted_label: string | null;
  encrypted_credentials: string | null;
  credentials_key_version: number | null;
  status: string;
  last_sync_at: string | null;
  /**
   * Sync progress for regular connections. An opaque provider cursor, text.
   * Null on stealth rows, which do not have one.
   */
  last_sync_cursor: string | null;
  /**
   * Sync progress for stealth connections. A chain block height, integer.
   * Null on regular rows, which do not have one.
   *
   * Deliberately a SECOND field rather than a value coerced into
   * `last_sync_cursor`. The two are different things with different types: a
   * consumer that treats the cursor as opaque and hands it back to a provider
   * would ship it a number, and one that reads it as a height would get a
   * provider's cursor string. Null is honest and branchable. A wrong number
   * is the one outcome nobody can detect later.
   */
  last_block_scanned: number | null;
  encrypted_last_error: string | null;
  created_at: string;
  source_wallets: unknown[];
}

/**
 * Stealth statuses are `active | error | archived`. The `connections`
 * vocabulary is `pending | active | error | disconnected | partial`.
 * `archived` is not in it, so emitting it raw would hand every consumer a
 * value it has no branch for.
 *
 * A Map, not an object literal, and deliberately so. With an object literal,
 * a status of `constructor` or `__proto__` resolves through the prototype
 * chain to a truthy value, which would slip past a `??` fallback and emit a
 * function or an object where a status string belongs. A Map has no
 * prototype keys.
 */
const STEALTH_STATUS_MAP: ReadonlyMap<string, string> = new Map([
  ['active', 'active'],
  ['error', 'error'],
  ['archived', 'disconnected'],
]);

/**
 * Map a stealth status into the `connections` vocabulary.
 *
 * An unrecognised status maps to `error`, never to `active`. If OR adds a
 * fourth stealth status and this map is not updated, the failure must be a
 * connection that looks broken and gets looked at, not one that reports
 * healthy while nothing syncs. A path that recognised nothing must not
 * return the value that means all is well.
 */
export function mapStealthStatus(status: string): string {
  return STEALTH_STATUS_MAP.get(status) ?? 'error';
}

/** True when `mapStealthStatus` had no rule and fell back. Caller logs it. */
export function isUnmappedStealthStatus(status: string): boolean {
  return !STEALTH_STATUS_MAP.has(status);
}

/**
 * Project one stealth row into the unified shape.
 *
 * `provider_type` carries `connection_kind` verbatim (`xpub_stealth` /
 * `descriptor_stealth`). No new vocabulary is invented here, so a consumer
 * that logs an unknown provider logs the real one.
 *
 * `encrypted_label` is null because the label material is sealed under the
 * app's key. A plaintext label must never be synthesized server side: the
 * server does not know it, and inventing one would put readable text where
 * the whole feature promises there is none.
 *
 * `last_sync_cursor` and `encrypted_last_error` are null: the stealth store
 * has neither. Scan progress is surfaced as `last_block_scanned` instead,
 * side by side rather than coerced into the cursor field.
 */
export function stealthRowToConnection(row: StealthConnectionRow): UnifiedConnection {
  return {
    id: row.id,
    provider_type: row.connection_kind,
    is_stealth: true,
    encrypted_label: null,
    encrypted_credentials: null,
    credentials_key_version: null,
    status: mapStealthStatus(row.status),
    last_sync_at: row.last_sync_at ?? null,
    last_sync_cursor: null,
    last_block_scanned: row.last_block_scanned ?? null,
    encrypted_last_error: null,
    created_at: row.created_at,
    source_wallets: [],
  };
}

/**
 * Mark a regular row as non-stealth and give it the stealth-only fields as
 * null.
 *
 * Both are emitted explicitly rather than left absent. `undefined` is falsy
 * and would mostly work for `is_stealth`, but "one shape" means a consumer
 * reads a field off any row and gets a value of the right type, not a value
 * on some rows and nothing on others. `last_block_scanned` is null here
 * because the `connections` table has no such column, which is a fact about
 * the row rather than a gap in the response.
 */
export function tagRegularConnection<T extends Record<string, unknown>>(
  row: T,
): T & { is_stealth: boolean; last_block_scanned: number | null } {
  return { ...row, is_stealth: false, last_block_scanned: null };
}

/**
 * The single alarmable string for a degraded stealth read.
 *
 * The endpoint degrades rather than fails when the stealth store cannot be
 * read: blanking a user's working bank connections over an unrelated store is
 * a bigger blast radius than one missing row, on the app's main read path.
 *
 * The cost of that choice is that the visible symptom of a degraded read is a
 * missing connection, which is exactly the bug this union exists to fix. So
 * degradation must never be silent. Every degrade site emits this exact
 * token, so one GlitchTip alarm catches all of them, and adding a new degrade
 * site without the token is the thing to look for in review.
 *
 * Deliberately a bare uppercase token with no punctuation or interpolation:
 * it has to survive log formatting and be greppable as a literal.
 */
export const STEALTH_UNAVAILABLE_ALARM = 'STEALTH_UNION_UNAVAILABLE';

/**
 * The single alarmable string for a degraded source_wallets read.
 *
 * Distinct from STEALTH_UNAVAILABLE_ALARM on purpose (DL-1038): the
 * source_wallets bulk load degrades the wallet badges on REGULAR
 * connections and has nothing to do with the stealth store. A shared token
 * would let one GlitchTip alarm mean two different failures, which is
 * worse than two alarms.
 *
 * Same bare-uppercase-token shape as STEALTH_UNAVAILABLE_ALARM, for the
 * same reason: it has to survive log formatting and be greppable as a
 * literal.
 */
export const SOURCE_WALLETS_UNAVAILABLE_ALARM = 'SOURCE_WALLETS_UNAVAILABLE';

/**
 * A unified row carrying the DL-1737 freshness fields.
 *
 * A separate type rather than three more required fields on
 * `UnifiedConnection`, so the two projections above stay responsible for
 * exactly what they read out of their own store, and the freshness fields get
 * added in one place for both families at once. See
 * ../_shared/sync-freshness.ts for what the signal measures and, more
 * importantly, what it does not.
 */
export type UnifiedConnectionWithFreshness = UnifiedConnection & SyncFreshnessFields;

/**
 * Attach the freshness fields to every row in one pass.
 *
 * `now` is a parameter, read once by the caller, so every row in a single
 * response is measured against a single instant. Read per row instead, two
 * connections stamped at the same moment could land on opposite sides of the
 * threshold inside the same payload.
 *
 * Applied to the MERGED list rather than inside `tagRegularConnection` and
 * `stealthRowToConnection` separately, because "one shape" only holds if both
 * families get the fields from the same code.
 */
export function withSyncFreshness(
  connections: ReadonlyArray<UnifiedConnection>,
  now: Date,
): UnifiedConnectionWithFreshness[] {
  return connections.map(c => ({ ...c, ...computeSyncFreshness(c.last_sync_at, now) }));
}

/** The endpoint's response body. */
export interface ListResponse {
  connections: UnifiedConnectionWithFreshness[];
  /**
   * True when the stealth store could not be read and the list may therefore
   * be short. Lets the client say "some connections could not be loaded"
   * instead of quietly showing an incomplete list.
   *
   * Always present as a boolean, never omitted on the happy path. A key that
   * appears only on failure is a key clients forget to check, and the whole
   * point of this flag is that the failure stops being invisible.
   */
  stealth_unavailable: boolean;
  /**
   * True when the source_wallets bulk read failed for one or more of the
   * connections in this response, so some of them may be missing their
   * wallet badges (`source_wallets: []` looks identical to "no wallets set
   * up" otherwise). DL-1038.
   *
   * A separate field from `stealth_unavailable` on purpose: the two are
   * different failure modes on different stores, and a client that wants to
   * show a "wallet badge unavailable" notice must be able to do that
   * without also triggering stealth-mode fallback UI.
   *
   * Always present as a boolean, never omitted on the happy path, for the
   * same reason `stealth_unavailable` is: a key that appears only on
   * failure is a key clients forget to check.
   */
  source_wallets_unavailable: boolean;
}

/**
 * Build the response body.
 *
 * `stealth_unavailable` is about whether the stealth store could be READ, not
 * about whether it returned anything. A user with no stealth connections gets
 * `false` and an unchanged list; that is a successful read of an empty set,
 * not a degraded one. Conflating the two would fire the alarm for every
 * ordinary user who has never used Stealth Sync.
 */
export function buildListResponse(
  connections: UnifiedConnectionWithFreshness[],
  stealthUnavailable: boolean,
  sourceWalletsUnavailable: boolean,
): ListResponse {
  return {
    connections,
    stealth_unavailable: stealthUnavailable,
    source_wallets_unavailable: sourceWalletsUnavailable,
  };
}

/** Epoch millis for sorting. Unparseable timestamps sort last, never first. */
function createdAtMillis(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Merge both families into one newest-first list.
 *
 * Both queries are already ordered, but concatenating two sorted lists does
 * not give a sorted list. Without this the stealth rows would clump at one
 * end regardless of when they were created, and a connection made minutes
 * ago would render below one from July.
 */
export function mergeConnections(
  regular: ReadonlyArray<UnifiedConnection>,
  stealth: ReadonlyArray<UnifiedConnection>,
): UnifiedConnection[] {
  return [...regular, ...stealth].sort(
    (a, b) => createdAtMillis(b.created_at) - createdAtMillis(a.created_at),
  );
}
