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

export type EventType = "sync.completed";

export interface SyncCompletedEvent {
  /** UUID per delivery. Use for consumer-side dedupe. */
  id: string;
  type: "sync.completed";
  data: {
    subaccount_id: string;
    connection_id: string;
    synced_count: number;
    /** ISO 8601 timestamp emitted by Orange Rails at dispatch. */
    ts: string;
  };
}

export type Event = SyncCompletedEvent;
