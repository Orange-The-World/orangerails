/**
 * waitForDeliveryAck - delivery acknowledgement gate for Stealth Sync (DL-0807).
 *
 * When the consuming app sets require_delivery_ack: true on the INIT message,
 * the widget posts SYNC_COMPLETE with pending_delivery_ack: true BEFORE
 * advancing the sync cursor. It then calls this function to wait for the
 * consuming app to post OR_STEALTH_DELIVERY_ACK, confirming that the app
 * has saved the sealed transactions to its own store.
 *
 * Only after the ack does the widget write the cursor via
 * or-stealth-envelope-update. If the ack does not arrive within timeoutMs
 * (default: 30 000 ms), DeliveryAckMissingError is thrown and the cursor
 * is never written, leaving the next sync free to re-scan safely from the
 * stored cursor.
 *
 * The eventTarget parameter is window in production. It is an injected
 * interface so tests can drive it without a browser environment.
 */

/** Thrown when OR_STEALTH_DELIVERY_ACK is not received within the timeout. */
export class DeliveryAckMissingError extends Error {
  constructor() {
    super(
      "Delivery acknowledgement not received within the required window. " +
        "The sync cursor was not advanced; the next sync will re-scan from " +
        "the stored cursor.",
    );
    this.name = "DeliveryAckMissingError";
  }
}

type MessageEventLike = { origin: string; data: unknown };

/** Minimal event-target interface. Pass `window` in production. */
export interface AckEventTarget {
  addEventListener(type: "message", handler: (e: MessageEventLike) => void): void;
  removeEventListener(type: "message", handler: (e: MessageEventLike) => void): void;
}

/**
 * Returns a promise that resolves when OR_STEALTH_DELIVERY_ACK arrives from
 * the expected origin and connection, or rejects with DeliveryAckMissingError
 * after timeoutMs milliseconds.
 */
export function waitForDeliveryAck(
  eventTarget: AckEventTarget,
  returnOrigin: string,
  connectionId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      eventTarget.removeEventListener("message", handler);
      reject(new DeliveryAckMissingError());
    }, timeoutMs);

    function handler(e: MessageEventLike) {
      if (settled) return;
      if (e.origin !== returnOrigin) return;
      const msg = e.data as { type?: string; connection_id?: string };
      if (
        msg?.type === "OR_STEALTH_DELIVERY_ACK" &&
        msg.connection_id === connectionId
      ) {
        settled = true;
        clearTimeout(timer);
        eventTarget.removeEventListener("message", handler);
        resolve();
      }
    }

    eventTarget.addEventListener("message", handler);
  });
}
