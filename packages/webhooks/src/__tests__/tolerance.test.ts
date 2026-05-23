import { describe, it, expect } from "vitest";
import { constructEvent } from "../construct-event";
import {
  TimestampToleranceExceededError,
  SignatureVerificationError,
} from "../errors";
import { computeHmacSha256Hex } from "../verify";

const SECRET = "whsec_tolerance_test";
const EVENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const body = JSON.stringify({
  type: "sync.completed",
  data: {
    subaccount_id: "s",
    connection_id: "c",
    synced_count: 1,
    ts: "2026-05-22T00:00:00.000Z",
  },
});

async function v2(ts: number, secret = SECRET, b = body) {
  const sig = await computeHmacSha256Hex(secret, `${ts}.${b}`);
  return `t=${ts},v1=${sig}`;
}

describe("v2 timestamp tolerance window", () => {
  it("accepts a signature exactly at the default tolerance edge (300s old)", async () => {
    const now = 2_000_000_000;
    const ts = now - 300;
    const header = await v2(ts);
    const evt = await constructEvent({
      rawBody: body,
      headers: {
        "x-or-signature-v2": header,
        "x-or-event-id": EVENT_ID,
      },
      secret: SECRET,
      now: () => now,
    });
    expect(evt.type).toBe("sync.completed");
  });

  it("rejects a signature 301s old", async () => {
    const now = 2_000_000_000;
    const ts = now - 301;
    const header = await v2(ts);
    await expect(
      constructEvent({
        rawBody: body,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
        now: () => now,
      }),
    ).rejects.toBeInstanceOf(TimestampToleranceExceededError);
  });

  it("rejects a signature 301s in the future (clock skew the other way)", async () => {
    const now = 2_000_000_000;
    const ts = now + 301;
    const header = await v2(ts);
    await expect(
      constructEvent({
        rawBody: body,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
        now: () => now,
      }),
    ).rejects.toBeInstanceOf(TimestampToleranceExceededError);
  });

  it("honors a custom (tighter) tolerance", async () => {
    const now = 2_000_000_000;
    const ts = now - 60;
    const header = await v2(ts);
    await expect(
      constructEvent({
        rawBody: body,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
        tolerance: 30,
        now: () => now,
      }),
    ).rejects.toBeInstanceOf(TimestampToleranceExceededError);
  });

  it("honors a custom (looser) tolerance", async () => {
    const now = 2_000_000_000;
    const ts = now - 600;
    const header = await v2(ts);
    const evt = await constructEvent({
      rawBody: body,
      headers: {
        "x-or-signature-v2": header,
        "x-or-event-id": EVENT_ID,
      },
      secret: SECRET,
      tolerance: 900,
      now: () => now,
    });
    expect(evt.type).toBe("sync.completed");
  });

  it("checks signature BEFORE tolerance (bad sig + old ts -> signature error, not tolerance error)", async () => {
    // Old timestamp but signed with the WRONG secret. The signature
    // failure should fire first, because we shouldn't trust the
    // attacker-supplied timestamp until the HMAC validates it.
    const now = 2_000_000_000;
    const ts = now - 10_000;
    const header = await v2(ts, "wrong-secret");
    try {
      await constructEvent({
        rawBody: body,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
        now: () => now,
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignatureVerificationError);
      expect(err).not.toBeInstanceOf(TimestampToleranceExceededError);
    }
  });
});
