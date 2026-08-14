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

/** Columns read from `stealth_connections`. No envelope column, on purpose. */
export interface StealthConnectionRow {
  id: string;
  connection_kind: string;
  status: string;
  last_sync_at: string | null;
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
  last_sync_cursor: string | null;
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
 * `last_sync_cursor` and `encrypted_last_error` are null. The stealth store
 * has no cursor, and its scan progress lives in `last_block_scanned`, which
 * is a block height and not a cursor. Stuffing a height into a cursor field
 * would be a lie in a field consumers already read.
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
    encrypted_last_error: null,
    created_at: row.created_at,
    source_wallets: [],
  };
}

/**
 * Mark a regular row as non-stealth.
 *
 * Emitted explicitly rather than left absent. `undefined` is falsy and would
 * mostly work, but "one shape" means a consumer can read `is_stealth` off
 * any row and get a boolean, not a boolean on some rows and nothing on
 * others.
 */
export function tagRegularConnection<T extends Record<string, unknown>>(
  row: T,
): T & { is_stealth: boolean } {
  return { ...row, is_stealth: false };
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
