/**
 * Tests for waitForDeliveryAck (DL-0807).
 *
 * These tests verify the delivery-acknowledgement gate that prevents the
 * Stealth Sync widget from advancing the sync cursor until the consuming
 * app has confirmed it saved the sealed transactions.
 *
 * The key invariant: when OR_STEALTH_DELIVERY_ACK never arrives,
 * waitForDeliveryAck rejects with DeliveryAckMissingError and the
 * cursor-write block in sync.tsx is never reached.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryAckMissingError, waitForDeliveryAck } from "./deliveryAck";

type MessageHandler = (e: { origin: string; data: unknown }) => void;

/** Build a minimal stub that captures and fires message listeners. */
function makeTarget() {
  const handlers: MessageHandler[] = [];
  return {
    addEventListener(_: "message", h: MessageHandler) {
      handlers.push(h);
    },
    removeEventListener(_: "message", h: MessageHandler) {
      const idx = handlers.indexOf(h);
      if (idx !== -1) handlers.splice(idx, 1);
    },
    fire(origin: string, data: unknown) {
      handlers.forEach((h) => h({ origin, data }));
    },
    get listenerCount() {
      return handlers.length;
    },
  };
}

describe("waitForDeliveryAck", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when OR_STEALTH_DELIVERY_ACK arrives from the correct origin and connection", async () => {
    const target = makeTarget();
    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 5000);
    target.fire("https://app.example.com", {
      type: "OR_STEALTH_DELIVERY_ACK",
      connection_id: "conn-1",
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("cleans up the listener after resolution", async () => {
    const target = makeTarget();
    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 5000);
    target.fire("https://app.example.com", {
      type: "OR_STEALTH_DELIVERY_ACK",
      connection_id: "conn-1",
    });
    await p;
    expect(target.listenerCount).toBe(0);
  });

  it("rejects with DeliveryAckMissingError when no ack arrives: cursor cannot advance", async () => {
    vi.useFakeTimers();
    const target = makeTarget();

    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);

    // Advance past the 30-second timeout without ever firing the ack.
    // In sync.tsx the cursor-write block runs AFTER awaiting this promise,
    // so a rejection here means the cursor is never written.
    vi.advanceTimersByTime(30_001);

    await expect(p).rejects.toBeInstanceOf(DeliveryAckMissingError);
  });

  it("does not resolve when the ack arrives from the wrong origin", async () => {
    vi.useFakeTimers();
    const target = makeTarget();

    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);

    // Wrong origin - must be ignored to prevent origin confusion attacks.
    target.fire("https://evil.example.com", {
      type: "OR_STEALTH_DELIVERY_ACK",
      connection_id: "conn-1",
    });

    vi.advanceTimersByTime(30_001);
    await expect(p).rejects.toBeInstanceOf(DeliveryAckMissingError);
  });

  it("does not resolve when the ack is for a different connection_id", async () => {
    vi.useFakeTimers();
    const target = makeTarget();

    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);

    // Different connection - must not be mistaken for our ack.
    target.fire("https://app.example.com", {
      type: "OR_STEALTH_DELIVERY_ACK",
      connection_id: "conn-OTHER",
    });

    vi.advanceTimersByTime(30_001);
    await expect(p).rejects.toBeInstanceOf(DeliveryAckMissingError);
  });

  it("ignores messages of unrelated types from the correct origin", async () => {
    vi.useFakeTimers();
    const target = makeTarget();

    const p = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);

    target.fire("https://app.example.com", {
      type: "OR_STEALTH_SYNC_COMPLETE",
      connection_id: "conn-1",
    });

    vi.advanceTimersByTime(30_001);
    await expect(p).rejects.toBeInstanceOf(DeliveryAckMissingError);
  });

  it("resolves on re-delivery after a prior timeout: at-least-once delivery guarantee", async () => {
    // Accepted behaviour (DL-0807): this gate provides at-least-once delivery,
    // not exactly-once. When no ack arrives within 30 s the cursor is NOT
    // written and the next sync re-delivers the same block window. Integrators
    // MUST handle duplicate windows idempotently (e.g. last-write-wins on
    // connection_id + block range).
    //
    // This test proves the gate is stateless: a second call after a timeout
    // starts a fresh wait with no memory of the prior failure.
    vi.useFakeTimers();
    const target = makeTarget();

    // First attempt: integrator stays silent. Cursor cannot advance.
    const first = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);
    vi.advanceTimersByTime(30_001);
    await expect(first).rejects.toBeInstanceOf(DeliveryAckMissingError);

    // Second attempt: next sync re-delivers the same window. Integrator acks
    // this time. The gate has no state from the first attempt, so it resolves.
    const second = waitForDeliveryAck(target, "https://app.example.com", "conn-1", 30_000);
    target.fire("https://app.example.com", {
      type: "OR_STEALTH_DELIVERY_ACK",
      connection_id: "conn-1",
    });
    await expect(second).resolves.toBeUndefined();
  });
});
