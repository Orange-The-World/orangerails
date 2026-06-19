import { describe, it, expect } from "vitest";
import { constructEvent } from "../construct-event";
import {
  MissingSignatureError,
  SignatureVerificationError,
  TimestampToleranceExceededError,
} from "../errors";
import { computeHmacSha256Hex } from "../verify";

const SECRET = "whsec_test_super_secret";
const EVENT_ID = "11111111-2222-3333-4444-555555555555";

const validBody = JSON.stringify({
  type: "sync.completed",
  data: {
    subaccount_id: "sub_123",
    connection_id: "conn_456",
    synced_count: 42,
    ts: "2026-05-22T12:00:00.000Z",
  },
});

async function v1Sig(body: string, secret = SECRET) {
  return computeHmacSha256Hex(secret, body);
}

async function v2Header(body: string, ts: number, secret = SECRET) {
  const sig = await computeHmacSha256Hex(secret, `${ts}.${body}`);
  return `t=${ts},v1=${sig}`;
}

describe("constructEvent , v1 (legacy X-OR-Signature)", () => {
  it("verifies a valid v1 signature and returns typed Event", async () => {
    const sig = await v1Sig(validBody);
    const evt = await constructEvent({
      rawBody: validBody,
      headers: {
        "x-or-signature": sig,
        "x-or-event-id": EVENT_ID,
      },
      secret: SECRET,
    });
    expect(evt.id).toBe(EVENT_ID);
    expect(evt.type).toBe("sync.completed");
    expect(evt.data.subaccount_id).toBe("sub_123");
    expect(evt.data.synced_count).toBe(42);
  });

  it("throws SignatureVerificationError on tampered body", async () => {
    const sig = await v1Sig(validBody);
    await expect(
      constructEvent({
        rawBody: validBody + " ",
        headers: { "x-or-signature": sig, "x-or-event-id": EVENT_ID },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("throws on wrong secret", async () => {
    const sig = await v1Sig(validBody, "different-secret");
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: { "x-or-signature": sig, "x-or-event-id": EVENT_ID },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("throws MissingSignatureError when no signature header present", async () => {
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: { "x-or-event-id": EVENT_ID },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(MissingSignatureError);
  });

  it("throws MissingSignatureError when X-OR-Event-Id missing", async () => {
    const sig = await v1Sig(validBody);
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: { "x-or-signature": sig },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(MissingSignatureError);
  });
});

describe("constructEvent , v2 (X-OR-Signature-V2, Stripe format)", () => {
  it("verifies a valid v2 signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await v2Header(validBody, ts);
    const evt = await constructEvent({
      rawBody: validBody,
      headers: {
        "x-or-signature-v2": header,
        "x-or-event-id": EVENT_ID,
      },
      secret: SECRET,
    });
    expect(evt.id).toBe(EVENT_ID);
    expect(evt.type).toBe("sync.completed");
  });

  it("prefers v2 over v1 when both headers are present", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const v2 = await v2Header(validBody, ts);
    // Intentionally bogus v1 sig , v2 should win and pass.
    const evt = await constructEvent({
      rawBody: validBody,
      headers: {
        "x-or-signature-v2": v2,
        "x-or-signature": "deadbeef".repeat(8),
        "x-or-event-id": EVENT_ID,
      },
      secret: SECRET,
    });
    expect(evt.type).toBe("sync.completed");
  });

  it("throws on malformed v2 header (no t=)", async () => {
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: {
          "x-or-signature-v2": "v1=deadbeef",
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("throws on tampered body under v2", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await v2Header(validBody, ts);
    await expect(
      constructEvent({
        rawBody: validBody.replace("42", "9999"),
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("rejects attacker-controlled v2 header that re-signs a different body with attacker secret", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await v2Header(validBody, ts, "attacker-secret");
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("throws TimestampToleranceExceededError when timestamp is too old", async () => {
    const ts = Math.floor(Date.now() / 1000) - 10_000;
    const header = await v2Header(validBody, ts);
    await expect(
      constructEvent({
        rawBody: validBody,
        headers: {
          "x-or-signature-v2": header,
          "x-or-event-id": EVENT_ID,
        },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(TimestampToleranceExceededError);
  });
});

describe("constructEvent , payload parsing", () => {
  it("throws on unsupported event type", async () => {
    const body = JSON.stringify({ type: "future.event", data: {} });
    const sig = await v1Sig(body);
    await expect(
      constructEvent({
        rawBody: body,
        headers: { "x-or-signature": sig, "x-or-event-id": EVENT_ID },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("throws on non-JSON body even with valid signature", async () => {
    const body = "not json";
    const sig = await v1Sig(body);
    await expect(
      constructEvent({
        rawBody: body,
        headers: { "x-or-signature": sig, "x-or-event-id": EVENT_ID },
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("accepts header keys in any case", async () => {
    const sig = await v1Sig(validBody);
    const evt = await constructEvent({
      rawBody: validBody,
      headers: {
        "X-OR-Signature": sig,
        "X-OR-Event-Id": EVENT_ID,
      },
      secret: SECRET,
    });
    expect(evt.id).toBe(EVENT_ID);
  });

  it("handles array-valued headers (Node http style)", async () => {
    const sig = await v1Sig(validBody);
    const evt = await constructEvent({
      rawBody: validBody,
      headers: {
        "x-or-signature": [sig],
        "x-or-event-id": [EVENT_ID],
      },
      secret: SECRET,
    });
    expect(evt.id).toBe(EVENT_ID);
  });
});
