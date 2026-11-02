/**
 * Public event types delivered by Orange Rails webhooks.
 *
 * `Event` is a discriminated union on the `type` field, so consumers can
 * narrow with `if (event.type === 'sync.completed') { ... }` and get
 * full type inference on `event.data`.
 *
 * Adding a new event type later (e.g. `sync.failed`,
 * `connection.created`) is a backwards-compatible addition: define the
 * new interface, add the literal to `EventType`, and add the interface
 * to the `Event` union.
 */

export type EventType = "sync.completed" | "connection.errored";

export interface SyncCompletedEvent {
  /** UUID per delivery. Use for consumer-side dedupe. */
  id: string;
  type: "sync.completed";
  data: {
    subaccount_id: string;
    connection_id: string;
    synced_count: number;
    /**
     * Upstream provider that triggered this sync, e.g. 'quiltt', 'strike', 'blink'.
     * Required. Branch on this when you need to handle providers differently.
     */
    provider: string;
    /** ISO 8601 timestamp emitted by Orange Rails at dispatch. */
    ts: string;
  };
}

/**
 * Closed list of reasons a connection reports an error. The sender only
 * ever emits one of these codes, never a raw provider message or free
 * text. A new code is a contract change. Treat any code you do not
 * recognise as `UNKNOWN`.
 *
 * - `USER_ACTION_REQUIRED`: the end user must reconnect.
 * - `INSTITUTION_ERROR`: the provider reports a problem with the institution.
 * - `PROVIDER_ERROR`: the provider reports a problem with the connection.
 * - `SERVICE_ERROR`: an unexpected error occurred while syncing.
 * - `UNKNOWN`: an error of a kind this list does not cover yet.
 */
export type ConnectionErroredReasonCode =
  | "USER_ACTION_REQUIRED"
  | "INSTITUTION_ERROR"
  | "PROVIDER_ERROR"
  | "SERVICE_ERROR"
  | "UNKNOWN";

/**
 * Sent when a connection reports an explicit error and cannot sync until
 * it is resolved. At most one per connection in any rolling 24 hours.
 * The payload is exactly these four fields.
 */
export interface ConnectionErroredEvent {
  /** UUID per delivery. Use for consumer-side dedupe. */
  id: string;
  type: "connection.errored";
  data: {
    subaccount_id: string;
    connection_id: string;
    reason_code: ConnectionErroredReasonCode;
    /**
     * True only when the documented fix is for the end user to reconnect.
     * False does not mean the connection will recover on its own.
     */
    repairable: boolean;
  };
}

export type Event = SyncCompletedEvent | ConnectionErroredEvent;
