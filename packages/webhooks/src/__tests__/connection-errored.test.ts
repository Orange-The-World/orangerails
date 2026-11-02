import { describe, it, expect } from "vitest";
import { constructEvent } from "../construct-event";
import { SignatureVerificationError } from "../errors";
import { computeHmacSha256Hex } from "../verify";

const SECRET = "whsec_test_super_secret";
const EVENT_ID = "11111111-2222-3333-4444-555555555555";

const erroredBody = JSON.stringify({
  type: "connection.errored",
  data: {
    subaccount_id: "sub_123",
    connection_id: "conn_456",
    reason_code: "USER_ACTION_REQUIRED",
    repairable: true,
  },
});

// Signs `signedBody` but delivers `rawBody`, so a mismatch models tampering.
async function receive(rawBody: string, signedBody = rawBody) {
  const sig = await computeHmacSha256Hex(SECRET, signedBody);
  return constructEvent({
    rawBody,
    headers: { "x-or-signature": sig, "x-or-event-id": EVENT_ID },
    secret: SECRET,
  });
}

describe("constructEvent connection.errored", () => {
  it("returns a typed connection.errored event", async () => {
    const evt = await receive(erroredBody);
    expect(evt).toMatchObject({
      id: EVENT_ID,
      type: "connection.errored",
      data: {
        subaccount_id: "sub_123",
        connection_id: "conn_456",
        reason_code: "USER_ACTION_REQUIRED",
        repairable: true,
      },
    });
  });

  it("still refuses a body that does not match its signature", async () => {
    await expect(
      receive(erroredBody, `${erroredBody} `),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it("still throws for an event type outside the contract", async () => {
    const body = JSON.stringify({ type: "connection.recovered", data: {} });
    await expect(receive(body)).rejects.toBeInstanceOf(
      SignatureVerificationError,
    );
  });
});
