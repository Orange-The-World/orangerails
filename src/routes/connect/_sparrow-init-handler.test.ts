/**
 * Unit tests for _sparrow-init-handler.ts (DL-0448).
 *
 * Covers all five guards in sendInitOnReady and the happy-path payload.
 * These run in vitest without a browser, a real Supabase session, or a
 * running vault -- that isolation is the reason the helper was extracted.
 *
 * vitest include glob: src/**\/\*.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { sendInitOnReady } from "./_sparrow-init-handler";

const SELF_ORIGIN = "https://connect.orangerails.com";

const SESSION = {
  user: { id: "user-123" },
  access_token: "tok-abc",
};

async function okSession() {
  return SESSION;
}
async function nullSession() {
  return null;
}
async function okKey() {
  return "base64key==";
}
async function throwKey(): Promise<string> {
  throw new Error("crypto failure");
}

function makePopup() {
  return { postMessage: vi.fn() };
}

function makeEvent(popup: ReturnType<typeof makePopup>, overrides: Partial<{
  source: unknown;
  origin: string;
  data: unknown;
}> = {}) {
  return {
    source: popup as unknown,
    origin: SELF_ORIGIN,
    data: { type: "OR_STEALTH_READY" } as unknown,
    ...overrides,
  };
}

describe("sendInitOnReady", () => {
  it("returns false when event.source is a different window", async () => {
    const popup = makePopup();
    const otherWindow = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup, { source: otherWindow }),
      popup,
      SELF_ORIGIN,
      okSession,
      okKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false when event.origin does not match selfOrigin (cross-origin impersonation)", async () => {
    const popup = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup, { origin: "https://evil.example.com" }),
      popup,
      SELF_ORIGIN,
      okSession,
      okKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false when event.data.type is not OR_STEALTH_READY", async () => {
    const popup = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup, { data: { type: "OR_STEALTH_INIT" } }),
      popup,
      SELF_ORIGIN,
      okSession,
      okKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false when event.data is null (missing type field)", async () => {
    const popup = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup, { data: null }),
      popup,
      SELF_ORIGIN,
      okSession,
      okKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false when getSession returns null (anonymous visitor)", async () => {
    const popup = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup),
      popup,
      SELF_ORIGIN,
      nullSession,
      okKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false and logs a warning when getStealthKey throws (non-fatal crypto error)", async () => {
    const popup = makePopup();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendInitOnReady(
      makeEvent(popup),
      popup,
      SELF_ORIGIN,
      okSession,
      throwKey,
    );
    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[sparrow]"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("posts OR_STEALTH_INIT at selfOrigin and returns true on the happy path", async () => {
    const popup = makePopup();
    const result = await sendInitOnReady(
      makeEvent(popup),
      popup,
      SELF_ORIGIN,
      okSession,
      okKey,
    );
    expect(result).toBe(true);
    expect(popup.postMessage).toHaveBeenCalledOnce();

    const [msg, targetOrigin] = popup.postMessage.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(targetOrigin).toBe(SELF_ORIGIN);
    expect(msg.type).toBe("OR_STEALTH_INIT");
    expect(msg.app_slug).toBe("or");
    expect(msg.app_user_id).toBe(SESSION.user.id);
    expect(msg.access_token).toBe(SESSION.access_token);
    expect(msg.mode).toBe("add");
    expect(msg.or_stealth_key_b64).toBe("base64key==");
    expect(msg.return_callback_origin).toBe(SELF_ORIGIN);
    expect(msg.gap_limit).toBe(250);
    expect(typeof msg.protocol_version).toBe("number");
    expect(msg.protocol_version as number).toBeGreaterThan(0);
  });

  it("posts INIT targeted exactly at selfOrigin, not at wildcard origin", async () => {
    const popup = makePopup();
    await sendInitOnReady(makeEvent(popup), popup, SELF_ORIGIN, okSession, okKey);
    const [, targetOrigin] = popup.postMessage.mock.calls[0] as [unknown, string];
    expect(targetOrigin).toBe(SELF_ORIGIN);
    expect(targetOrigin).not.toBe("*");
  });
});
